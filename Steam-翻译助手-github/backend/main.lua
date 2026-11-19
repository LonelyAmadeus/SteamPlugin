local logger     = require("logger")
local millennium = require("millennium")

require("rpc_functions")

local function on_load()
    logger:info("Steam Translator loaded, Millennium " .. millennium.version())
    millennium.ready()
end

local function on_unload()
    logger:info("Steam Translator unloaded")
end

return {
    on_load = on_load,
    on_unload = on_unload,
}
