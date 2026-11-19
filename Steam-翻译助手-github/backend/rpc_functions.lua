local logger = require("logger")
local http   = require("http")

-- cjson is shipped as "json" in some Millennium builds and "cjson" in others
local ok, cjson = pcall(require, "cjson")
if not ok or type(cjson) ~= "table" then
    cjson = require("json")
end

local SEP = "\n@@@\n"

local function pickConfigDir()
    local bases = {
        [[D:\Apps\Steam]],
        (os.getenv("ProgramFiles(x86)") or "") .. [[\Steam]],
        (os.getenv("ProgramFiles") or "") .. [[\Steam]],
        (os.getenv("LOCALAPPDATA") or "") .. [[\Steam]],
    }
    for _, base in ipairs(bases) do
        if base ~= "" then
            local probe = base .. [[\millennium\config]]
            local f = io.open(base .. [[\steam.exe]], "r")
            if f then
                f:close()
                return probe
            end
        end
    end
    return [[D:\Apps\Steam\millennium\config]]
end

local CONFIG_DIR = pickConfigDir()
local CONFIG_FILE = CONFIG_DIR .. [[\ds-tr-config.json]]
local LOG_FILE = CONFIG_DIR .. [[\ds-tr.log]]
-- 译文缓存：跨页面、跨重启保存，避免每次进页面都重新花钱翻译
local CACHE_FILE = CONFIG_DIR .. [[\ds-tr-cache.json]]

local config = {
    autoTranslate = false,
    apiKey = "",
    url = "https://api.deepseek.com/chat/completions",
    model = "deepseek-chat",
    -- 输入框手动翻译的目标语言（只影响“一键翻译输入框”，不影响整页翻译）
    targetLang = "English",
    debugInline = false,
}

local LOG_LIMIT = 2 * 1024 * 1024

local function rotateLogIfNeeded()
    local f = io.open(LOG_FILE, "rb")
    if not f then return end
    local size = f:seek("end") or 0
    f:close()
    if size > LOG_LIMIT then os.remove(LOG_FILE) end
end

local function note(msg)
    rotateLogIfNeeded()
    local f = io.open(LOG_FILE, "a")
    if f then
        f:write(os.date("%H:%M:%S "), tostring(msg), "\n")
        f:close()
    end
end

local function jdecode(str)
    local fn = cjson.decode or (cjson.safe and cjson.safe.decode)
    if not fn then return nil end
    local okd, val = pcall(fn, str)
    if okd then return val end
    return nil
end

local function loadConfig()
    local f = io.open(CONFIG_FILE, "r")
    if not f then return end
    local raw = f:read("*a")
    f:close()
    local t = jdecode(raw)
    if type(t) ~= "table" then return end
    config.autoTranslate = t.autoTranslate == true
    if type(t.apiKey) == "string" then config.apiKey = t.apiKey end
    if type(t.url) == "string" and t.url ~= "" then config.url = t.url end
    if type(t.model) == "string" and t.model ~= "" then config.model = t.model end
    if type(t.targetLang) == "string" and t.targetLang ~= "" then config.targetLang = t.targetLang end
    if type(t.debugInline) == "boolean" then config.debugInline = t.debugInline end
end

local function jencode(val)
    local fn = cjson.encode or (cjson.safe and cjson.safe.encode)
    if not fn then return "{}" end
    local oke, out = pcall(fn, val)
    if oke then return out end
    return "{}"
end

local function saveConfig()
    local encoded = jencode(config)
    if not encoded then return false end
    local f = io.open(CONFIG_FILE, "w")
    if not f then return false end
    local wrote = f:write(encoded)
    local closed = f:close()
    return wrote and closed
end
-- ── 译文缓存 ────────────────────────────────────────────────────────────────
-- key = 源文（去首尾空白），value = 译文。跨页面、跨重启保留，
-- 进页面时先回填缓存，命中就零成本，不再重复调用 API。
local cache = {}
local CACHE_LIMIT = 40000

local function cacheCount()
    local n = 0
    for _ in pairs(cache) do n = n + 1 end
    return n
end

local function loadCache()
    local f = io.open(CACHE_FILE, "r")
    if not f then return end
    local raw = f:read("*a")
    f:close()
    local t = jdecode(raw)
    if type(t) == "table" then cache = t end
end

local function saveCache()
    local encoded = jencode(cache)
    if not encoded then return false end
    local tmp = CACHE_FILE .. ".tmp"
    local f = io.open(tmp, "w")
    if not f then return false end
    f:write(encoded)
    f:close()
    os.remove(CACHE_FILE)
    return os.rename(tmp, CACHE_FILE) ~= nil
end

---@ffi
---@param payloadJson string
---@return table
function deleteCache(payloadJson)
    local t = jdecode(payloadJson)
    local keys = type(t) == "table" and t.keys or nil
    if type(keys) ~= "table" then
        return { ok = false, error = "bad payload" }
    end
    local removed = 0
    for _, k in ipairs(keys) do
        if type(k) == "string" and cache[k] ~= nil then
            cache[k] = nil
            removed = removed + 1
        end
    end
    if removed > 0 then saveCache() end
    return { ok = true, removed = removed }
end

---@ffi
---@return table
function getCacheStats()
    local entries = cacheCount()
    local bytes = 0
    local f = io.open(CACHE_FILE, "rb")
    if f then
        bytes = f:seek("end") or 0
        f:close()
    end
    if bytes == 0 then
        local encoded = jencode(cache)
        bytes = encoded and #encoded or 0
    end
    return { ok = true, entries = entries, bytes = bytes }
end
---@ffi
---@return table
function getCache()
    return { ok = true, map = cache }
end

---@ffi
---@param payloadJson string
---@return table
function putCache(payloadJson)
    local t = jdecode(payloadJson)
    local entries = type(t) == "table" and t.entries or nil
    if type(entries) ~= "table" then
        return { ok = false, error = "bad payload" }
    end
    local added = 0
    for src, tr in pairs(entries) do
        if type(src) == "string" and src ~= "" and type(tr) == "string" and cache[src] ~= tr then
            cache[src] = tr
            added = added + 1
        end
    end
    if added > 0 then
        if cacheCount() > CACHE_LIMIT then
            -- 轻量淘汰：清掉一半，避免缓存文件无限膨胀
            local drop = math.floor(CACHE_LIMIT / 2)
            for k in pairs(cache) do
                if drop <= 0 then break end
                cache[k] = nil
                drop = drop - 1
            end
        end
        saveCache()
    end
    return { ok = true, added = added, size = cacheCount() }
end

---@ffi
---@return table
function clearCache()
    cache = {}
    saveCache()
    return { ok = true }
end

local SYSTEM_PROMPT = table.concat({
    "你是专业的游戏页面翻译。把用户给的文本翻译成简体中文，源文本可能是英语、韩语、日语等，自动识别。",
    "文本由若干段组成，段与段之间用单独一行的 @@@ 分隔。",
    "必须保持同样数量的段落和同样的 @@@ 分隔符，逐段对应翻译。",
    "只输出译文，不要解释、不要加引号、不要用 Markdown。",
    "专有名词保留原文，游戏术语用玩家习惯的说法。",
}, "")

local function split(text, sep)
    local out = {}
    local from = 1
    while true do
        local s, e = string.find(text, sep, from, true)
        if not s then
            out[#out + 1] = string.sub(text, from)
            break
        end
        out[#out + 1] = string.sub(text, from, s - 1)
        from = e + 1
    end
    return out
end

---@ffi
---@param payloadJson string
---@return string
function translateAll(payloadJson)
    note("translateAll entered")

    if config.apiKey == "" then
        note("no api key")
        return { ok = false, error = "NO_KEY" }
    end

    note("cjson ok=" .. tostring(cjson ~= nil) .. " decode=" .. tostring(cjson.decode ~= nil) .. " safe=" .. tostring(cjson.safe ~= nil))
    local req = jdecode(payloadJson)
    if not req or type(req.texts) ~= "table" or #req.texts == 0 then
        note("bad request")
        return { ok = false, error = "empty request" }
    end

    local body = jencode({
        model = config.model,
        temperature = 0,
        messages = {
            { role = "system", content = SYSTEM_PROMPT },
            { role = "user", content = table.concat(req.texts, SEP) },
        },
    })

    note("posting, blocks=" .. #req.texts .. " bytes=" .. #body)

    local res, err = http.request(config.url, {
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

    note("post returned status=" .. tostring(res and res.status) .. " err=" .. tostring(err))

    if not res then
        return { ok = false, error = tostring(err) }
    end
    if res.status ~= 200 then
        note("body: " .. string.sub(tostring(res.body), 1, 200))
        return { ok = false, error = "HTTP " .. tostring(res.status) }
    end

    local decoded = jdecode(res.body)
    if not decoded or not decoded.choices or not decoded.choices[1] then
        note("bad json")
        return { ok = false, error = "bad response" }
    end

    if decoded.choices[1].finish_reason == "length" then
        return { ok = false, error = "OUTPUT_LIMIT" }
    end
    local message = decoded.choices[1].message
    local content = message and message.content or ""
    content = string.gsub(content, "^%s+", "")
    content = string.gsub(content, "%s+$", "")

    local parts = #req.texts == 1 and { content } or split(content, SEP)
    note("parsed blocks=" .. #parts)

    return { ok = true, texts = parts }
end

---@ffi
---@param payloadJson string
---@return table
function translateText(payloadJson)
    if config.apiKey == "" then
        return { ok = false, error = "NO_KEY" }
    end
    local req = jdecode(payloadJson)
    local text = type(req) == "table" and req.text or nil
    if type(text) ~= "string" or text == "" then
        return { ok = false, error = "empty text" }
    end
    local lang = (type(req) == "table" and type(req.lang) == "string" and req.lang ~= "") and req.lang or config.targetLang
    local system = table.concat({
        "你是专业翻译。把用户给的文本翻译成" .. lang .. "。",
        "只输出译文，不要解释、不要加引号、不要使用 Markdown 代码块。",
        "保留原文中的链接、占位符（如 %s、{0}、<tag>）与专有名词不变。",
        "如果原文已经是该语言，原样返回。",
    }, "")

    local body = jencode({
        model = config.model,
        temperature = 0,
        messages = {
            { role = "system", content = system },
            { role = "user", content = text },
        },
    })

    local res, err = http.request(config.url, {
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

    if not res then
        return { ok = false, error = tostring(err) }
    end
    if res.status ~= 200 then
        note("translateText status " .. tostring(res.status))
        return { ok = false, error = "HTTP " .. tostring(res.status) }
    end

    local decoded = jdecode(res.body)
    local message = decoded and decoded.choices and decoded.choices[1] and decoded.choices[1].message
    local content = message and message.content or ""
    content = string.gsub(content, "^%s+", "")
    content = string.gsub(content, "%s+$", "")
    if content == "" then
        return { ok = false, error = "empty response" }
    end

    return { ok = true, text = content, lang = lang }
end

---@ffi
---@param msg string
---@return string
function noteFromWeb(msg)
    note(msg)
    return "ok"
end


---@ffi
---@return table
function getConfig()
    return { autoTranslate = config.autoTranslate, hasKey = config.apiKey ~= "", apiKey = config.apiKey, url = config.url, model = config.model, targetLang = config.targetLang, debugInline = config.debugInline }
end

---@ffi
---@param payloadJson string
---@return table
function setConfig(payloadJson)
    local t = jdecode(payloadJson)
    if type(t) ~= "table" then
        return { ok = false, error = "bad config" }
    end
    if type(t.autoTranslate) == "boolean" then
        local old = config.autoTranslate
        config.autoTranslate = t.autoTranslate
        if not saveConfig() then
            config.autoTranslate = old
            return { ok = false, error = "保存自动翻译设置失败" }
        end
        return { ok = true }
    end
    -- 只有显式传了 url 且确实变了才清空 key（局部保存不能把 key 抹掉）
    if type(t.url) == "string" and t.url ~= config.url then config.apiKey = "" end
    if type(t.apiKey) == "string" and t.apiKey ~= "" then config.apiKey = t.apiKey end
    if type(t.url) == "string" then
        config.url = (t.url ~= "") and t.url or "https://api.deepseek.com/chat/completions"
    end
    if type(t.model) == "string" then
        config.model = (t.model ~= "") and t.model or "deepseek-chat"
    end
    if type(t.targetLang) == "string" and t.targetLang ~= "" then
        config.targetLang = t.targetLang
    end
    saveConfig()
    return { ok = true, hasKey = (config.apiKey ~= "") }
end

loadConfig()
loadCache()
logger:info("Steam translator RPC registered")
