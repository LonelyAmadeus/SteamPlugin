local logger = require("logger")
local http = require("http")
local millennium = require("millennium")
local fs = require("fs")

local ok, cjson = pcall(require, "cjson")
if not ok or type(cjson) ~= "table" then
    cjson = require("json")
end

local SEP = "\n@@@\n"
local DEFAULT_URL = "https://api.deepseek.com/chat/completions"
local steamPath = millennium.steam_path()
assert(type(steamPath) == "string" and steamPath ~= "", "Steam installation path unavailable")
local CONFIG_DIR = string.gsub(steamPath, "[/\\]+$", "") .. [[\millennium\config]]
fs.create_directories(CONFIG_DIR)
local CONFIG_FILE = CONFIG_DIR .. [[\ds-tr-config.json]]
local LOG_FILE = CONFIG_DIR .. [[\ds-tr.log]]
local CACHE_FILE = CONFIG_DIR .. [[\ds-tr-cache.json]]
local LOG_LIMIT = 2 * 1024 * 1024
local CACHE_LIMIT = 40000
local CACHE_BYTES_LIMIT = 12 * 1024 * 1024
local CACHE_FILE_LIMIT = 40 * 1024 * 1024
local IMPORT_LIMIT = 40 * 1024 * 1024
local ENTRY_TEXT_LIMIT = 16384

local config = {
    autoTranslate = false,
    apiKey = "",
    url = DEFAULT_URL,
    model = "deepseek-chat",
    targetLang = "English",
    pageTargetLang = "简体中文",
    glossary = "",
    displayMode = "replace",
    autoRules = {},
    debugInline = false,
}

local cacheData = { version = 2, generation = 0, sequence = 0, buckets = {} }

local function jdecode(str)
    if type(str) ~= "string" then return nil end
    local fn = cjson.decode or (cjson.safe and cjson.safe.decode)
    if not fn then return nil end
    local okd, value = pcall(fn, str)
    if okd then return value end
    return nil
end

local function jencode(value)
    local fn = cjson.encode or (cjson.safe and cjson.safe.encode)
    if not fn then return nil end
    local oke, encoded = pcall(fn, value)
    if oke and type(encoded) == "string" then return encoded end
    return nil
end

local function replaceAllLiteral(text, literal, replacement)
    if literal == "" then return text end
    local output, from = {}, 1
    while true do
        local startAt, endAt = string.find(text, literal, from, true)
        if not startAt then
            output[#output + 1] = string.sub(text, from)
            break
        end
        output[#output + 1] = string.sub(text, from, startAt - 1)
        output[#output + 1] = replacement
        from = endAt + 1
    end
    return table.concat(output)
end

local function trim(value)
    return (string.gsub(string.gsub(value, "^%s+", ""), "%s+$", ""))
end

local function hasControl(value)
    return string.find(value, "%c") ~= nil
end

local function isSafeEndpoint(url)
    if type(url) ~= "string" or #url == 0 or #url > 2048 or string.find(url, "[%c%s\\]") then
        return false
    end
    local scheme, authority = string.match(url, "^([%a]+)://([^/%?#]+)")
    if not scheme or not authority or string.find(authority, "@", 1, true) then return false end
    scheme = string.lower(scheme)
    local host, suffix = string.match(authority, "^%[([%x:%.]+)%](.*)$")
    if not host then host, suffix = string.match(authority, "^([%w%.%-]+)(.*)$") end
    if not host or (suffix ~= "" and not string.match(suffix, "^:%d+$")) then return false end
    if suffix ~= "" then
        local port = tonumber(string.sub(suffix, 2))
        if not port or port < 1 or port > 65535 then return false end
    end
    host = string.lower(host)
    if scheme == "https" then return true end
    return scheme == "http" and (host == "localhost" or host == "127.0.0.1" or host == "::1")
end

local function validRuleKey(key)
    if type(key) ~= "string" then return false end
    if key == "steam:store" or key == "steam:community" or key == "steam:workshop"
        or key == "steam:help" or key == "steam:checkout" or key == "steam:library"
        or key == "steam:chat" or key == "steam:other" then
        return true
    end
    return string.match(key, "^app:%d+$") ~= nil and #key <= 24
end

local function copyRules(source)
    local result = {}
    if type(source) == "table" then
        for key, value in pairs(source) do
            if validRuleKey(key) and (value == "on" or value == "off") then
                result[key] = value
            end
        end
    end
    return result
end

local function cloneConfig()
    local copy = {}
    for key, value in pairs(config) do
        if key == "autoRules" then
            copy.autoRules = copyRules(value)
        else
            copy[key] = value
        end
    end
    return copy
end

local function safeRead(path, limit)
    local f = io.open(path, "rb")
    if not f then return nil end
    local size = f:seek("end") or 0
    if size > limit then
        f:close()
        return nil
    end
    f:seek("set", 0)
    local raw = f:read("*a")
    f:close()
    return raw
end

local function atomicWrite(path, content)
    local tmp = path .. ".tmp"
    local backup = path .. ".bak"
    os.remove(tmp)
    local f = io.open(tmp, "wb")
    if not f then return false end
    local wrote = f:write(content)
    if not wrote then
        f:close()
        os.remove(tmp)
        return false
    end
    if f.flush and not f:flush() then
        f:close()
        os.remove(tmp)
        return false
    end
    local closed = f:close()
    if not closed then
        os.remove(tmp)
        return false
    end

    if os.rename(tmp, path) then return true end

    local mainExists = io.open(path, "rb")
    if not mainExists then
        local recovered = os.rename(tmp, path)
        if not recovered then os.remove(tmp) end
        return recovered ~= nil
    end
    mainExists:close()

    os.remove(backup)
    if not os.rename(path, backup) then
        os.remove(tmp)
        return false
    end
    if os.rename(tmp, path) then
        os.remove(backup)
        return true
    end
    os.rename(backup, path)
    os.remove(tmp)
    return false
end

local function writeJson(path, value)
    local encoded = jencode(value)
    if not encoded then return false end
    return atomicWrite(path, encoded)
end

local function readJsonWithBackup(path, limit)
    local primary = jdecode(safeRead(path, limit))
    if type(primary) == "table" then return primary end
    local backupPath = path .. ".bak"
    local backup = jdecode(safeRead(backupPath, limit))
    if type(backup) == "table" then
        local corruptPath = path .. ".corrupt"
        os.remove(corruptPath)
        local movedPrimary = os.rename(path, corruptPath)
        if os.rename(backupPath, path) then
            os.remove(corruptPath)
        elseif movedPrimary then
            os.rename(corruptPath, path)
        end
        return backup
    end
    return nil
end

local function loadConfig()
    local stored = readJsonWithBackup(CONFIG_FILE, 2 * 1024 * 1024)
    if type(stored) ~= "table" then return end

    config.autoTranslate = stored.autoTranslate == true
    if type(stored.apiKey) == "string" and #stored.apiKey <= 4096 and not hasControl(stored.apiKey) then
        config.apiKey = stored.apiKey
    end
    if type(stored.url) == "string" and stored.url ~= "" then config.url = stored.url end
    if type(stored.model) == "string" and #stored.model <= 128 and not hasControl(stored.model) and stored.model ~= "" then
        config.model = stored.model
    end
    if type(stored.targetLang) == "string" and #stored.targetLang <= 80 and not hasControl(stored.targetLang) and stored.targetLang ~= "" then
        config.targetLang = stored.targetLang
    end
    if type(stored.pageTargetLang) == "string" and #stored.pageTargetLang <= 80 and not hasControl(stored.pageTargetLang) and stored.pageTargetLang ~= "" then
        config.pageTargetLang = stored.pageTargetLang
    end
    if type(stored.glossary) == "string" and #stored.glossary <= 32768 then config.glossary = stored.glossary end
    if stored.displayMode == "bilingual" then config.displayMode = "bilingual" end
    config.autoRules = copyRules(stored.autoRules)
    if type(stored.debugInline) == "boolean" then config.debugInline = stored.debugInline end
end

local function redactSecrets(message)
    local result = tostring(message or "")
    if type(config.apiKey) == "string" and config.apiKey ~= "" then
        result = replaceAllLiteral(result, config.apiKey, "[REDACTED]")
    end
    if #result > 2000 then result = string.sub(result, 1, 2000) end
    return result
end

local function rotateLogIfNeeded()
    local f = io.open(LOG_FILE, "rb")
    if not f then return end
    local size = f:seek("end") or 0
    f:close()
    if size > LOG_LIMIT then os.remove(LOG_FILE) end
end

local function note(message)
    rotateLogIfNeeded()
    local f = io.open(LOG_FILE, "a")
    if f then
        f:write(os.date("%H:%M:%S "), redactSecrets(message), "\n")
        f:close()
    end
end

local function makeBaseScope()
    local values = { config.url, config.model, config.pageTargetLang, config.glossary }
    local material = ""
    for _, value in ipairs(values) do
        material = material .. tostring(#value) .. ":" .. value
    end
    local a, b, c = 5381, 52711, 2166136261
    for index = 1, #material do
        local byte = string.byte(material, index)
        a = (a * 131 + byte) % 2147483647
        b = (b * 65599 + byte) % 2147483629
        c = (c * 33 + byte) % 2147483587
    end
    return "v2:" .. tostring(a) .. ":" .. tostring(b) .. ":" .. tostring(c)
end

local function validCacheText(text)
    return type(text) == "string" and #text > 0 and #text <= ENTRY_TEXT_LIMIT
end

local function validCacheBucket(source)
    local bucket = { entries = {}, used = {}, epoch = 0 }
    if type(source) ~= "table" then return bucket end
    if type(source.epoch) == "number" and source.epoch >= 0 then bucket.epoch = math.floor(source.epoch) end
    if type(source.entries) == "table" then
        for text, translated in pairs(source.entries) do
            if validCacheText(text) and validCacheText(translated) then
                bucket.entries[text] = translated
                local used = type(source.used) == "table" and source.used[text] or nil
                bucket.used[text] = (type(used) == "number" and used >= 0) and used or 0
            end
        end
    end
    return bucket
end

local saveCache
local trimCache

local function loadCache()
    local stored = readJsonWithBackup(CACHE_FILE, CACHE_FILE_LIMIT)
    if type(stored) ~= "table" then return end
    if stored.version == 2 and type(stored.buckets) == "table" then
        cacheData.generation = (type(stored.generation) == "number" and math.max(0, math.floor(stored.generation))) or 0
        cacheData.sequence = (type(stored.sequence) == "number" and math.max(0, math.floor(stored.sequence))) or 0
        for scope, bucket in pairs(stored.buckets) do
            if type(scope) == "string" and #scope <= 128 then
                cacheData.buckets[scope] = validCacheBucket(bucket)
                for _, used in pairs(cacheData.buckets[scope].used) do
                    if used > cacheData.sequence then cacheData.sequence = used end
                end
            end
        end
        if trimCache() then saveCache() end
        return
    end

    local legacy = stored
    if type(stored.entries) == "table" then legacy = stored.entries end
    local bucket = { entries = {}, used = {}, epoch = 0 }
    for text, translated in pairs(legacy) do
        if validCacheText(text) and validCacheText(translated) then
            bucket.entries[text] = translated
            cacheData.sequence = cacheData.sequence + 1
            bucket.used[text] = cacheData.sequence
        end
    end
    if next(bucket.entries) then
        cacheData.buckets[makeBaseScope()] = bucket
        trimCache()
        note("legacy cache migrated")
        saveCache()
    end
end

local function getCurrentBucket(create)
    local base = makeBaseScope()
    local bucket = cacheData.buckets[base]
    if not bucket and create then
        bucket = { entries = {}, used = {}, epoch = 0 }
        cacheData.buckets[base] = bucket
    end
    return base, bucket
end

local function getCurrentScope()
    local _, bucket = getCurrentBucket(false)
    local epoch = bucket and bucket.epoch or 0
    return makeBaseScope() .. ":" .. tostring(cacheData.generation) .. ":" .. tostring(epoch)
end

local function cacheCount()
    local count = 0
    for _, bucket in pairs(cacheData.buckets) do
        for _ in pairs(bucket.entries) do count = count + 1 end
    end
    return count
end

local function cacheByteEstimate()
    local bytes = 0
    for _, bucket in pairs(cacheData.buckets) do
        for text, translated in pairs(bucket.entries) do
            bytes = bytes + #text + #translated + 32
        end
    end
    return bytes
end

local function touch(bucket, text)
    cacheData.sequence = cacheData.sequence + 1
    bucket.used[text] = cacheData.sequence
end

trimCache = function()
    local count, bytes = cacheCount(), cacheByteEstimate()
    if count <= CACHE_LIMIT and bytes <= CACHE_BYTES_LIMIT then return false end
    local ordered = {}
    for scope, bucket in pairs(cacheData.buckets) do
        for text in pairs(bucket.entries) do
            ordered[#ordered + 1] = { scope = scope, text = text, used = bucket.used[text] or 0 }
        end
    end
    table.sort(ordered, function(left, right)
        if left.used ~= right.used then return left.used < right.used end
        if left.scope ~= right.scope then return left.scope < right.scope end
        return left.text < right.text
    end)
    for _, item in ipairs(ordered) do
        local bucket = cacheData.buckets[item.scope]
        bytes = bytes - #item.text - #bucket.entries[item.text] - 32
        count = count - 1
        bucket.entries[item.text], bucket.used[item.text] = nil, nil
        if count <= CACHE_LIMIT and bytes <= CACHE_BYTES_LIMIT then break end
    end
    return true
end

saveCache = function()
    local encoded = jencode(cacheData)
    if not encoded or #encoded > CACHE_FILE_LIMIT then return false end
    return atomicWrite(CACHE_FILE, encoded)
end

local function checkScope(scope)
    local current = getCurrentScope()
    if scope ~= nil and scope ~= current then return false, current end
    return true, current
end

---@ffi
---@param payloadJson string
---@return table
function lookupCache(payloadJson)
    local request = jdecode(payloadJson)
    if type(request) ~= "table" or type(request.texts) ~= "table" then
        return { ok = false, error = "bad payload", scope = getCurrentScope() }
    end
    local valid, scope = checkScope(request.scope)
    if not valid then return { ok = false, error = "SCOPE_CHANGED", scope = scope } end
    local _, bucket = getCurrentBucket(true)
    local map = {}
    local count = 0
    for _, text in ipairs(request.texts) do
        if validCacheText(text) then
            count = count + 1
            local translated = bucket.entries[text]
            if translated then
                map[text] = translated
                touch(bucket, text)
            end
        end
        if count >= 2000 then break end
    end
    return { ok = true, map = map, scope = scope }
end

---@ffi
---@return table
function getCacheStats()
    local _, bucket = getCurrentBucket(false)
    local entries = cacheCount()
    local currentEntries = 0
    if bucket then for _ in pairs(bucket.entries) do currentEntries = currentEntries + 1 end end
    local bytes = 0
    local f = io.open(CACHE_FILE, "rb")
    if f then bytes = f:seek("end") or 0; f:close() end
    if bytes == 0 then bytes = #(jencode(cacheData) or "") end
    local currentBytes = 0
    if bucket then
        for text, translated in pairs(bucket.entries) do currentBytes = currentBytes + #text + #translated + 32 end
    end
    local bucketCount = 0
    for _ in pairs(cacheData.buckets) do bucketCount = bucketCount + 1 end
    return {
        ok = true,
        entries = entries,
        currentEntries = currentEntries,
        buckets = bucketCount,
        bytes = bytes,
        currentBytes = currentBytes,
        scope = getCurrentScope(),
        maxEntries = CACHE_LIMIT,
        maxBytes = CACHE_BYTES_LIMIT,
    }
end

---@ffi
---@param payloadJson string
---@return table
function getCache(payloadJson)
    if type(payloadJson) == "string" then
        local request = jdecode(payloadJson)
        if type(request) == "table" and type(request.texts) == "table" then
            return lookupCache(payloadJson)
        end
    end
    local _, bucket = getCurrentBucket(false)
    local map = {}
    if bucket then
        for text, translated in pairs(bucket.entries) do map[text] = translated end
    end
    return { ok = true, map = map, scope = getCurrentScope() }
end

---@ffi
---@param payloadJson string
---@return table
function putCache(payloadJson)
    local request = jdecode(payloadJson)
    local entries = type(request) == "table" and request.entries or nil
    if type(entries) ~= "table" then return { ok = false, error = "bad payload", scope = getCurrentScope() } end
    local valid, scope = checkScope(request.scope)
    if not valid then return { ok = false, error = "SCOPE_CHANGED", scope = scope } end
    local _, bucket = getCurrentBucket(true)
    local added, changed = 0, false
    for text, translated in pairs(entries) do
        if validCacheText(text) and validCacheText(translated) and bucket.entries[text] ~= translated then
            bucket.entries[text] = translated
            touch(bucket, text)
            added = added + 1
            changed = true
        end
    end
    if changed then
        trimCache()
        if not saveCache() then return { ok = false, error = "cache save failed", added = added, scope = scope } end
    end
    return { ok = true, added = added, size = cacheCount(), scope = scope }
end

---@ffi
---@param payloadJson string
---@return table
function deleteCache(payloadJson)
    local request = jdecode(payloadJson)
    local keys = type(request) == "table" and request.keys or nil
    if type(keys) ~= "table" then return { ok = false, error = "bad payload", scope = getCurrentScope() } end
    local valid, scope = checkScope(request.scope)
    if not valid then return { ok = false, error = "SCOPE_CHANGED", scope = scope } end
    local _, bucket = getCurrentBucket(false)
    local removed = 0
    if bucket then
        for _, text in ipairs(keys) do
            if type(text) == "string" and bucket.entries[text] ~= nil then
                bucket.entries[text] = nil
                bucket.used[text] = nil
                removed = removed + 1
            end
        end
    end
    if removed > 0 and not saveCache() then return { ok = false, error = "cache save failed", removed = removed, scope = scope } end
    return { ok = true, removed = removed, scope = scope }
end

---@ffi
---@param payloadJson string
---@return table
function clearCache(payloadJson)
    local request = nil
    if payloadJson ~= nil then
        request = type(payloadJson) == "string" and jdecode(payloadJson) or nil
        if type(request) ~= "table" or (request.all ~= false and request.all ~= true) then
            return { ok = false, error = "bad payload", scope = getCurrentScope() }
        end
    end
    if type(request) == "table" and request.all == false then
        local valid, scope = checkScope(request.scope)
        if not valid then return { ok = false, error = "SCOPE_CHANGED", scope = scope } end
        local base, bucket = getCurrentBucket(true)
        bucket.entries = {}
        bucket.used = {}
        bucket.epoch = bucket.epoch + 1
        if not saveCache() then return { ok = false, error = "cache save failed", scope = scope } end
        return { ok = true, scope = getCurrentScope(), cleared = "current" }
    end
    cacheData.buckets = {}
    cacheData.generation = cacheData.generation + 1
    if not saveCache() then return { ok = false, error = "cache save failed", scope = getCurrentScope() } end
    return { ok = true, scope = getCurrentScope(), cleared = "all" }
end

---@ffi
---@return table
function exportCache()
    local _, bucket = getCurrentBucket(false)
    local entries = {}
    if bucket then
        for text, translated in pairs(bucket.entries) do entries[text] = translated end
    end
    local data = jencode({ version = 1, scope = makeBaseScope(), entries = entries })
    if not data then return { ok = false, error = "cache export failed", scope = getCurrentScope() } end
    if #data > IMPORT_LIMIT then return { ok = false, error = "cache export exceeds the import limit", scope = getCurrentScope() } end
    return { ok = true, data = data, entries = (function() local n = 0; for _ in pairs(entries) do n = n + 1 end; return n end)(), scope = getCurrentScope() }
end

---@ffi
---@param payloadJson string
---@return table
function importCache(payloadJson)
    if type(payloadJson) ~= "string" or #payloadJson > IMPORT_LIMIT then
        return { ok = false, error = "import is too large", scope = getCurrentScope() }
    end
    local request = jdecode(payloadJson)
    local raw = type(request) == "table" and type(request.data) == "string" and request.data or payloadJson
    if #raw > IMPORT_LIMIT then return { ok = false, error = "import is too large", scope = getCurrentScope() } end
    local document = jdecode(raw)
    if type(document) ~= "table" then return { ok = false, error = "invalid cache file", scope = getCurrentScope() } end
    if type(document.scope) == "string" and document.scope ~= makeBaseScope() then
        return { ok = false, error = "cache belongs to a different translation configuration", scope = getCurrentScope() }
    end
    local entries = type(document.entries) == "table" and document.entries or document
    local _, bucket = getCurrentBucket(true)
    local added = 0
    for text, translated in pairs(entries) do
        if validCacheText(text) and validCacheText(translated) and bucket.entries[text] ~= translated then
            bucket.entries[text] = translated
            touch(bucket, text)
            added = added + 1
        end
    end
    bucket.epoch = bucket.epoch + 1
    trimCache()
    if not saveCache() then return { ok = false, error = "cache save failed", added = added, scope = getCurrentScope() } end
    return { ok = true, added = added, size = cacheCount(), scope = getCurrentScope() }
end

local function parseGlossary()
    local terms = {}
    for line in string.gmatch(config.glossary .. "\n", "([^\n]*)\n") do
        local source, target = string.match(line, "^%s*(.-)%s*=>%s*(.-)%s*$")
        if not source then source, target = string.match(line, "^%s*(.-)%s*=%s*(.-)%s*$") end
        if source and target and source ~= "" and target ~= "" and #source <= 128 and #target <= 256 then
            terms[#terms + 1] = { source = source, target = target }
        end
    end
    table.sort(terms, function(left, right)
        if #left.source == #right.source then return left.source < right.source end
        return #left.source > #right.source
    end)
    return terms
end

local function countLiteral(text, literal)
    local count, from = 0, 1
    while true do
        local startAt, endAt = string.find(text, literal, from, true)
        if not startAt then break end
        count = count + 1
        from = endAt + 1
    end
    return count
end

local function protectText(text, state, blockIndex)
    local parts = { text }
    local function replaceUnprotected(pattern, literal, replacement)
        local nextParts = {}
        for _, part in ipairs(parts) do
            if type(part) == "table" then
                nextParts[#nextParts + 1] = part
            else
                local from = 1
                while from <= #part do
                    local first, last = string.find(part, pattern, from, literal)
                    if not first then
                        nextParts[#nextParts + 1] = string.sub(part, from)
                        break
                    end
                    if first > from then nextParts[#nextParts + 1] = string.sub(part, from, first - 1) end
                    state.nextToken = state.nextToken + 1
                    local token = state.tokenPrefix .. tostring(state.nextToken) .. "__"
                    state.tokens[token] = { replacement = replacement or string.sub(part, first, last), block = blockIndex }
                    nextParts[#nextParts + 1] = { token }
                    from = last + 1
                end
            end
        end
        parts = nextParts
    end
    for _, pattern in ipairs({ "<[^>]+>", "https?://[^%s<>]+", "{[^{}]+}", "%%[%d%$%+%-#0 ]*[%d%.]*[a-zA-Z]" }) do
        replaceUnprotected(pattern, false)
    end
    for _, term in ipairs(state.terms) do replaceUnprotected(term.source, true, term.target) end
    for index, part in ipairs(parts) do if type(part) == "table" then parts[index] = part[1] end end
    return table.concat(parts)
end

local function unprotectText(text, state, blockIndex)
    for token, record in pairs(state.tokens) do
        if record.block == blockIndex then
            if countLiteral(text, token) ~= 1 then return nil, "placeholder mismatch" end
            text = string.gsub(text, token, function() return record.replacement end)
        end
    end
    if string.find(text, state.tokenPrefix, 1, true) then return nil, "unexpected placeholder" end
    return text
end

local function newProtectionState(texts)
    local combined = table.concat(texts, "\n")
    local marker = "__STEAMTR_KEEP_7Q_"
    while string.find(combined, marker, 1, true) do marker = marker .. "X" end
    return { tokenPrefix = marker, tokens = {}, nextToken = 0, terms = parseGlossary() }
end

local function callTranslation(messages)
    if not isSafeEndpoint(config.url) then return nil, "unsafe endpoint" end
    local body = jencode({
        model = config.model,
        temperature = 0,
        messages = messages,
    })
    if not body then return nil, "request encoding failed" end
    local okRequest, response, requestError = pcall(http.request, config.url, {
        method = "POST",
        data = body,
        headers = {
            ["Content-Type"] = "application/json",
            ["Accept"] = "application/json",
            ["Authorization"] = "Bearer " .. config.apiKey,
        },
        timeout = 30,
        proxy = "",
    })
    if not okRequest then
        note("request failed")
        return nil, "request failed"
    end
    if not response then
        note("request returned no response")
        return nil, "request failed"
    end
    if type(response.status) ~= "number" or response.status < 200 or response.status >= 300 then
        note("request returned status=" .. tostring(response.status))
        return nil, "HTTP " .. tostring(response.status)
    end
    if type(response.body) ~= "string" or #response.body > 8 * 1024 * 1024 then
        return nil, "invalid response"
    end
    return response.body
end

local function responseContent(body)
    local decoded = jdecode(body)
    if type(decoded) ~= "table" then return nil, "bad response" end
    local choices = decoded.choices
    local first = type(choices) == "table" and choices[1] or nil
    if type(first) ~= "table" then return nil, "bad response" end
    if first.finish_reason == "length" then return nil, "OUTPUT_LIMIT" end
    local message = first.message
    if type(message) ~= "table" or type(message.content) ~= "string" then return nil, "bad response" end
    local content = trim(message.content)
    if content == "" then return nil, "empty response" end
    return content
end

local function isReservedSeparator(text)
    return string.find(text, SEP, 1, true) ~= nil
end

---@ffi
---@param payloadJson string
---@return table
function translateAll(payloadJson)
    local request = jdecode(payloadJson)
    if type(request) ~= "table" or type(request.texts) ~= "table" or #request.texts == 0 then
        return { ok = false, error = "empty request", scope = getCurrentScope() }
    end
    if config.apiKey == "" then return { ok = false, error = "NO_KEY", scope = getCurrentScope() } end
    local valid, scope = checkScope(request.scope)
    if not valid then return { ok = false, error = "SCOPE_CHANGED", scope = scope } end

    local totalBytes = 0
    local sourceTexts = {}
    for index, text in ipairs(request.texts) do
        if type(text) ~= "string" or #text == 0 or #text > ENTRY_TEXT_LIMIT or isReservedSeparator(text) then
            return { ok = false, error = "invalid text block", scope = scope }
        end
        totalBytes = totalBytes + #text
        if totalBytes > 160 * 1024 or index > 500 then return { ok = false, error = "request too large", scope = scope } end
        sourceTexts[index] = text
    end

    local state = newProtectionState(sourceTexts)
    local protected = {}
    for index, text in ipairs(sourceTexts) do protected[index] = protectText(text, state, index) end
    local systemPrompt = table.concat({
        "你是专业的游戏页面翻译。自动识别文本语言，并翻译成「", config.pageTargetLang, "」。",
        "文本由若干段组成，段与段之间用单独一行的 @@@ 分隔。",
        "必须保持相同数量和顺序的段落，原样保留所有以 __STEAMTR_KEEP_ 开头的占位标记。",
        "只输出译文，不要解释、不要加引号、不要使用 Markdown。",
    }, "")
    local body, err = callTranslation({
        { role = "system", content = systemPrompt },
        { role = "user", content = table.concat(protected, SEP) },
    })
    if not body then return { ok = false, error = err, scope = scope } end
    local content, responseError = responseContent(body)
    if not content then return { ok = false, error = responseError, scope = scope } end

    local translatedParts = #sourceTexts == 1 and { content } or (function()
        local parts = {}
        local from = 1
        while true do
            local startAt, endAt = string.find(content, SEP, from, true)
            if not startAt then
                parts[#parts + 1] = string.sub(content, from)
                break
            end
            parts[#parts + 1] = string.sub(content, from, startAt - 1)
            from = endAt + 1
        end
        return parts
    end)()
    if #translatedParts ~= #sourceTexts then
        return { ok = false, error = "BLOCK_COUNT_MISMATCH", scope = scope }
    end
    local final = {}
    for index, translated in ipairs(translatedParts) do
        local restored, restoreError = unprotectText(trim(translated), state, index)
        if not restored then return { ok = false, error = restoreError, scope = scope } end
        final[index] = restored
    end
    if getCurrentScope() ~= scope then return { ok = false, error = "SCOPE_CHANGED", scope = getCurrentScope() } end
    return { ok = true, texts = final, scope = scope, lang = config.pageTargetLang }
end

---@ffi
---@param payloadJson string
---@return table
function translateText(payloadJson)
    local request = jdecode(payloadJson)
    if type(request) ~= "table" then return { ok = false, error = "bad payload" } end
    local text = type(request) == "table" and request.text or nil
    local textLimit = request.purpose == "selection" and 48 * 1024 or ENTRY_TEXT_LIMIT
    if type(text) ~= "string" or #text == 0 or #text > textLimit then
        return { ok = false, error = "empty text" }
    end
    if config.apiKey == "" then return { ok = false, error = "NO_KEY" } end
    if isReservedSeparator(text) then return { ok = false, error = "invalid text" } end
    local valid, scope = checkScope(request.scope)
    if not valid then return { ok = false, error = "SCOPE_CHANGED", scope = scope } end
    local lang = (type(request.lang) == "string" and request.lang ~= "" and #request.lang <= 80 and not hasControl(request.lang))
        and request.lang
        or ((request.purpose == "selection") and config.pageTargetLang or config.targetLang)
    local state = newProtectionState({ text })
    local protectedText = protectText(text, state, 1)
    local systemPrompt = table.concat({
        "你是专业翻译。把用户给的文本翻译成「", lang, "」。",
        "只输出译文，不要解释、不要加引号、不要使用 Markdown 代码块。",
        "原样保留所有以 __STEAMTR_KEEP_ 开头的占位标记。",
        "如果原文已经是目标语言，原样返回。",
    }, "")
    local body, err = callTranslation({
        { role = "system", content = systemPrompt },
        { role = "user", content = protectedText },
    })
    if not body then return { ok = false, error = err } end
    local content, responseError = responseContent(body)
    if not content then return { ok = false, error = responseError } end
    local restored, restoreError = unprotectText(content, state, 1)
    if not restored then return { ok = false, error = restoreError } end
    if getCurrentScope() ~= scope then return { ok = false, error = "SCOPE_CHANGED", scope = getCurrentScope() } end
    return { ok = true, text = restored, lang = lang }
end

---@ffi
---@param msg string
---@return string
function noteFromWeb(msg)
    if config.debugInline then note(msg) end
    return "ok"
end

local function configPayload(includeKey)
    local result = {
        autoTranslate = config.autoTranslate,
        hasKey = config.apiKey ~= "",
        url = config.url,
        model = config.model,
        targetLang = config.targetLang,
        pageTargetLang = config.pageTargetLang,
        glossary = config.glossary,
        displayMode = config.displayMode,
        autoRules = copyRules(config.autoRules),
        debugInline = config.debugInline,
        scope = getCurrentScope(),
    }
    if includeKey then result.apiKey = config.apiKey end
    return result
end

---@ffi
---@return table
function getConfig()
    return configPayload(true)
end

---@ffi
---@return table
function getPublicConfig()
    return configPayload(false)
end

local function updateRulePatch(rules, patch)
    if type(patch) ~= "table" then return false end
    if not validRuleKey(patch.key) or (patch.mode ~= "on" and patch.mode ~= "off" and patch.mode ~= "inherit") then
        return nil
    end
    if patch.mode == "inherit" then rules[patch.key] = nil else rules[patch.key] = patch.mode end
    return true
end

---@ffi
---@param payloadJson string
---@return table
function setConfig(payloadJson)
    local incoming = jdecode(payloadJson)
    if type(incoming) ~= "table" then return { ok = false, error = "bad config" } end
    local old = cloneConfig()
    local function reject(message)
        config = old
        return { ok = false, error = message }
    end

    if type(incoming.apiKey) == "string" then
        if #incoming.apiKey > 4096 or hasControl(incoming.apiKey) then return reject("无效的 API Key") end
        if incoming.apiKey ~= "" then config.apiKey = incoming.apiKey end
    end
    if incoming.clearApiKey == true then config.apiKey = "" end
    if type(incoming.url) == "string" then
        local url = incoming.url ~= "" and incoming.url or DEFAULT_URL
        if not isSafeEndpoint(url) then return reject("接口地址必须使用 HTTPS（本机回环地址可使用 HTTP）") end
        config.url = url
    end
    if type(incoming.model) == "string" then
        if #incoming.model > 128 or hasControl(incoming.model) then return reject("模型名称无效") end
        config.model = incoming.model ~= "" and incoming.model or "deepseek-chat"
    end
    if type(incoming.targetLang) == "string" then
        if #incoming.targetLang > 80 or hasControl(incoming.targetLang) then return reject("输入框目标语言无效") end
        if incoming.targetLang ~= "" then config.targetLang = incoming.targetLang end
    end
    if type(incoming.pageTargetLang) == "string" then
        if #incoming.pageTargetLang > 80 or hasControl(incoming.pageTargetLang) then return reject("页面目标语言无效") end
        if incoming.pageTargetLang ~= "" then config.pageTargetLang = incoming.pageTargetLang end
    end
    if type(incoming.glossary) == "string" then
        if #incoming.glossary > 32768 then return reject("术语表过大") end
        config.glossary = incoming.glossary
    end
    if incoming.displayMode == "replace" or incoming.displayMode == "bilingual" then config.displayMode = incoming.displayMode end
    if type(incoming.autoTranslate) == "boolean" then config.autoTranslate = incoming.autoTranslate end
    if type(incoming.debugInline) == "boolean" then config.debugInline = incoming.debugInline end
    if type(incoming.autoRules) == "table" then config.autoRules = copyRules(incoming.autoRules) end
    if incoming.rulePatch ~= nil then
        local result = updateRulePatch(config.autoRules, incoming.rulePatch)
        if result == nil then return reject("无效的页面规则") end
    end

    if not writeJson(CONFIG_FILE, config) then
        config = old
        return { ok = false, error = "保存配置失败" }
    end
    return { ok = true, hasKey = config.apiKey ~= "", scope = getCurrentScope() }
end

loadConfig()
loadCache()
logger:info("Steam translator RPC registered")
