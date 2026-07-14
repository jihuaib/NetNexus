-- NetNexus BMP v4 TLV dissector for Wireshark.
-- Install this file into Wireshark's Personal Lua Plugins directory and
-- restart Wireshark. The dissector registers TCP port 1790 by default.

local bmp20 = Proto("netnexus_bmp20", "BMP v4 TLV draft-20 (NetNexus)")

local MSG_NAMES = {
    [0] = "Route Monitoring",
    [1] = "Statistics Report",
    [2] = "Peer Down Notification",
    [3] = "Peer Up Notification",
    [4] = "Initiation",
    [5] = "Termination",
    [6] = "Route Mirroring",
}

local PEER_TYPE_NAMES = {
    [0] = "Global",
    [1] = "L3VPN",
    [2] = "Local",
    [3] = "Loc-RIB",
}

local ROUTE_TLV_NAMES = {
    [1] = "Sequence Number",
    [2] = "Extended Flags",
    [3] = "Timestamp",
    [4] = "Group",
    [5] = "VRF/Table Name",
    [6] = "Stateless Parsing",
    [7] = "BGP Message",
    [8] = "Path Marking",
}

local LEGACY_ROUTE_TLV_NAMES = {
    [1] = "Stateless Parsing",
    [2] = "Group",
    [3] = "VRF/Table Name",
    [4] = "BGP Message",
    [5] = "Path Marking",
}

local COMMON_TLV_NAMES = {
    [1] = "Sequence Number",
    [2] = "Extended Flags",
    [3] = "Timestamp",
}

local INITIATION_TLV_NAMES = {
    [0] = "String",
    [1] = "sysDesc",
    [2] = "sysName",
    [3] = "VRF/Table Name",
}

local STATS_NAMES = {
    [0] = "Prefixes rejected",
    [1] = "Duplicate prefix advertisements",
    [2] = "Duplicate withdraws",
    [3] = "Updates invalidated by CLUSTER_LIST",
    [4] = "Updates invalidated by AS_PATH loop",
    [5] = "Updates invalidated by ORIGINATOR_ID",
    [6] = "Updates invalidated by AS_CONFED loop",
    [7] = "Adj-RIB-In prefixes",
    [8] = "Loc-RIB prefixes",
    [9] = "Per-AFI/SAFI Adj-RIB-In prefixes",
    [10] = "Per-AFI/SAFI Loc-RIB prefixes",
    [11] = "Updates treated as withdraw",
    [12] = "Prefixes treated as withdraw",
    [13] = "Duplicate update messages",
    [14] = "Pre-policy Adj-RIB-Out prefixes",
    [15] = "Post-policy Adj-RIB-Out prefixes",
    [16] = "Per-AFI/SAFI pre-policy Adj-RIB-Out prefixes",
    [17] = "Per-AFI/SAFI post-policy Adj-RIB-Out prefixes",
}

local PEER_DOWN_REASONS = {
    [1] = "Local system closed with notification",
    [2] = "Local system closed without notification",
    [3] = "Remote system closed with notification",
    [4] = "Remote system closed without notification",
    [5] = "Peer de-configured",
    [6] = "Local system closed with TLV",
}

local PATH_STATUS_BITS = {
    {0x00000001, "Invalid"},
    {0x00000002, "Best"},
    {0x00000004, "Nonselected"},
    {0x00000008, "Primary"},
    {0x00000010, "Backup"},
    {0x00000020, "Non-installed"},
    {0x00000040, "Best-external"},
    {0x00000080, "Add-Path"},
    {0x00000100, "Filtered in inbound policy"},
    {0x00000200, "Filtered in outbound policy"},
    {0x00000400, "Stale"},
    {0x00000800, "Suppressed"},
}

local PATH_STATUS_REASONS = {
    [1] = "Invalid due to AS loop",
    [2] = "Invalid due to unresolvable nexthop",
    [3] = "Not preferred for local preference",
    [4] = "Not preferred for AS Path Length",
    [5] = "Not preferred for origin",
    [6] = "Not preferred for MED",
    [7] = "Not preferred for peer type",
    [8] = "Not preferred for IGP cost",
    [9] = "Not preferred for router ID",
    [10] = "Not preferred for peer address",
    [11] = "Not preferred for AIGP",
}

local AFI_NAMES = {
    [1] = "IPv4",
    [2] = "IPv6",
    [25] = "L2VPN",
}

local SAFI_NAMES = {
    [1] = "Unicast",
    [2] = "Multicast",
    [4] = "MPLS Label",
    [70] = "EVPN",
    [128] = "MPLS VPN",
    [129] = "Multicast VPN",
}

local ADD_PATH_MODE_NAMES = {
    [1] = "Receive",
    [2] = "Send",
    [3] = "Send/Receive",
}

local PER_AFI_SAFI_STATS_TYPES = {
    [9] = true,
    [10] = true,
    [16] = true,
    [17] = true,
}

local f = {
    version = ProtoField.uint8("netnexus_bmp20.version", "Version", base.DEC),
    length = ProtoField.uint32("netnexus_bmp20.length", "Message Length", base.DEC),
    msg_type = ProtoField.uint8("netnexus_bmp20.msg_type", "Message Type", base.DEC, MSG_NAMES),
    peer_type = ProtoField.uint8("netnexus_bmp20.peer.type", "Peer Type", base.DEC, PEER_TYPE_NAMES),
    peer_flags = ProtoField.uint8("netnexus_bmp20.peer.flags", "Peer Flags", base.HEX),
    peer_rd = ProtoField.bytes("netnexus_bmp20.peer.rd", "Peer Distinguisher"),
    peer_addr_v4 = ProtoField.ipv4("netnexus_bmp20.peer.addr_v4", "Peer Address"),
    peer_addr_v6 = ProtoField.ipv6("netnexus_bmp20.peer.addr_v6", "Peer Address"),
    peer_as = ProtoField.uint32("netnexus_bmp20.peer.as", "Peer AS", base.DEC),
    peer_bgp_id = ProtoField.ipv4("netnexus_bmp20.peer.bgp_id", "Peer BGP ID"),
    peer_ts_sec = ProtoField.uint32("netnexus_bmp20.peer.ts_sec", "Timestamp Seconds", base.DEC),
    peer_ts_usec = ProtoField.uint32("netnexus_bmp20.peer.ts_usec", "Timestamp Microseconds", base.DEC),
    local_addr_v4 = ProtoField.ipv4("netnexus_bmp20.peer_up.local_addr_v4", "Local Address"),
    local_addr_v6 = ProtoField.ipv6("netnexus_bmp20.peer_up.local_addr_v6", "Local Address"),
    local_port = ProtoField.uint16("netnexus_bmp20.peer_up.local_port", "Local Port", base.DEC),
    remote_port = ProtoField.uint16("netnexus_bmp20.peer_up.remote_port", "Remote Port", base.DEC),
    peer_down_reason = ProtoField.uint8("netnexus_bmp20.peer_down.reason", "Reason", base.DEC, PEER_DOWN_REASONS),
    fsm_event_code = ProtoField.uint16("netnexus_bmp20.peer_down.fsm_event_code", "FSM Event Code", base.DEC),
    tlv_raw_type = ProtoField.uint16("netnexus_bmp20.tlv.raw_type", "Raw TLV Type", base.HEX),
    tlv_enterprise = ProtoField.bool("netnexus_bmp20.tlv.enterprise", "Enterprise-specific", 16, nil, 0x8000),
    tlv_type = ProtoField.uint16("netnexus_bmp20.tlv.type", "TLV Type", base.DEC),
    tlv_length = ProtoField.uint16("netnexus_bmp20.tlv.length", "TLV Length", base.DEC),
    tlv_raw_index = ProtoField.uint16("netnexus_bmp20.tlv.raw_index", "Raw TLV Index", base.HEX),
    tlv_group = ProtoField.bool("netnexus_bmp20.tlv.group_index", "Group Index", 16, nil, 0x8000),
    tlv_index = ProtoField.uint16("netnexus_bmp20.tlv.index", "TLV Index", base.DEC),
    tlv_pen = ProtoField.uint32("netnexus_bmp20.tlv.enterprise_number", "Enterprise Number", base.DEC),
    tlv_value = ProtoField.bytes("netnexus_bmp20.tlv.value", "Value"),
    tlv_text = ProtoField.string("netnexus_bmp20.tlv.text", "Text"),
    tlv_sequence = ProtoField.uint32("netnexus_bmp20.tlv.sequence", "Sequence Number", base.DEC),
    tlv_flags = ProtoField.uint8("netnexus_bmp20.tlv.flags", "Flags", base.HEX),
    tlv_ts_sec = ProtoField.uint32("netnexus_bmp20.tlv.ts_sec", "Timestamp Seconds", base.DEC),
    tlv_ts_usec = ProtoField.uint32("netnexus_bmp20.tlv.ts_usec", "Timestamp Microseconds", base.DEC),
    group_raw_index = ProtoField.uint16("netnexus_bmp20.group.raw_index", "Group Raw Index", base.HEX),
    group_index = ProtoField.uint16("netnexus_bmp20.group.index", "Group NLRI Index", base.DEC),
    path_status = ProtoField.uint32("netnexus_bmp20.path.status", "Path Status", base.HEX),
    path_status_names = ProtoField.string("netnexus_bmp20.path.status_names", "Path Status Names"),
    path_reason = ProtoField.uint16("netnexus_bmp20.path.reason", "Path Status Reason", base.DEC, PATH_STATUS_REASONS),
    path_reason_name = ProtoField.string("netnexus_bmp20.path.reason_name", "Path Status Reason Name"),
    cap_code = ProtoField.uint8("netnexus_bmp20.capability.code", "Capability Code", base.DEC),
    cap_length = ProtoField.uint8("netnexus_bmp20.capability.length", "Capability Length", base.DEC),
    add_path_afi = ProtoField.uint16("netnexus_bmp20.capability.add_path.afi", "ADD-PATH AFI", base.DEC, AFI_NAMES),
    add_path_safi = ProtoField.uint8("netnexus_bmp20.capability.add_path.safi", "ADD-PATH SAFI", base.DEC, SAFI_NAMES),
    add_path_mode = ProtoField.uint8("netnexus_bmp20.capability.add_path.mode", "ADD-PATH Send/Receive", base.DEC, ADD_PATH_MODE_NAMES),
    stats_count = ProtoField.uint32("netnexus_bmp20.stats.count", "Stats Count", base.DEC),
    stat_type = ProtoField.uint16("netnexus_bmp20.stat.type", "Stat Type", base.DEC, STATS_NAMES),
    stat_length = ProtoField.uint16("netnexus_bmp20.stat.length", "Stat Length", base.DEC),
    stat_value32 = ProtoField.uint32("netnexus_bmp20.stat.value32", "Stat Value", base.DEC),
    stat_value64 = ProtoField.string("netnexus_bmp20.stat.value64", "Stat Value"),
    stat_afi = ProtoField.uint16("netnexus_bmp20.stat.afi", "Stat AFI", base.DEC, AFI_NAMES),
    stat_safi = ProtoField.uint8("netnexus_bmp20.stat.safi", "Stat SAFI", base.DEC, SAFI_NAMES),
}

bmp20.fields = f
bmp20.prefs.tcp_port = Pref.uint("TCP port", 1790, "Register this dissector on a TCP port. Use 0 for Decode As only.")
bmp20.prefs.v4_tlv_draft = Pref.uint("BMPv4 TLV draft", 20, "Use 20 for draft-20 or 19 for draft-19 route TLV type numbers.")
bmp20.prefs.path_marking_tlv_type = Pref.uint("Path Marking TLV type", 0, "Route Monitoring Path Marking TLV type. Use 0 for the draft default.")

local ok_bgp, bgp_dissector = pcall(Dissector.get, "bgp")
if not ok_bgp then
    bgp_dissector = nil
end

local tcp_table = DissectorTable.get("tcp.port")
local registered_port = nil

local function msg_name(msg_type)
    return MSG_NAMES[msg_type] or ("Unknown " .. tostring(msg_type))
end

local function get_v4_tlv_draft()
    if tonumber(bmp20.prefs.v4_tlv_draft) == 19 then
        return 19
    end
    return 20
end

local function get_path_marking_tlv_type()
    local configured = tonumber(bmp20.prefs.path_marking_tlv_type) or 0
    if configured >= 1 and configured <= 0x3fff then
        return configured
    end
    return get_v4_tlv_draft() == 19 and 5 or 8
end

local function route_tlv_kind(tlv_type)
    local path_marking_type = get_path_marking_tlv_type()
    if tlv_type == path_marking_type then
        return "path_marking"
    end

    if get_v4_tlv_draft() == 19 then
        if tlv_type == 1 then return "stateless" end
        if tlv_type == 2 then return "group" end
        if tlv_type == 3 then return "vrf" end
        if tlv_type == 4 then return "bgp" end
        return "unknown"
    end

    if tlv_type == 1 then return "sequence" end
    if tlv_type == 2 then return "extended_flags" end
    if tlv_type == 3 then return "timestamp" end
    if tlv_type == 4 then return "group" end
    if tlv_type == 5 then return "vrf" end
    if tlv_type == 6 then return "stateless" end
    if tlv_type == 7 then return "bgp" end
    return "unknown"
end

local function route_tlv_name(tlv_type)
    if get_v4_tlv_draft() == 19 then
        if tlv_type == get_path_marking_tlv_type() then
            return "Path Marking"
        end
        return LEGACY_ROUTE_TLV_NAMES[tlv_type] or ("Unknown " .. tostring(tlv_type))
    end
    if tlv_type == get_path_marking_tlv_type() then
        return "Path Marking"
    end
    return ROUTE_TLV_NAMES[tlv_type] or ("Unknown " .. tostring(tlv_type))
end

local function generic_tlv_name(tlv_type, context)
    if context == "initiation" then
        return INITIATION_TLV_NAMES[tlv_type] or ("TLV " .. tostring(tlv_type))
    end

    if (context == "peer-up" or context == "peer-down" or context == "termination") and tlv_type == 3 then
        return "VRF/Table Name"
    end

    return COMMON_TLV_NAMES[tlv_type] or ("TLV " .. tostring(tlv_type))
end

local function is_text_tlv(context, tlv_type)
    if context == "initiation" then
        return tlv_type == 1 or tlv_type == 2 or tlv_type == 3
    end
    if context == "peer-up" or context == "peer-down" or context == "termination" then
        return tlv_type == 3
    end
    if context == "route" then
        return route_tlv_kind(tlv_type) == "vrf"
    end
    return false
end

local function bounded_len(tvb, offset, wanted, limit)
    if offset >= limit then
        return 0
    end
    local available = limit - offset
    if wanted > available then
        return available
    end
    return wanted
end

local function add_text_if_printable(tree, tvb, offset, length)
    if length <= 0 then
        return
    end

    local ok, text = pcall(function()
        return tvb(offset, length):string()
    end)
    if not ok or text == nil then
        return
    end

    if text:match("^[%g%s]+$") then
        tree:add(f.tlv_text, tvb(offset, length), text)
    end
end

local function uint64_to_string(range)
    local ok, value = pcall(function()
        return range:uint64()
    end)
    if ok and value ~= nil then
        return tostring(value)
    end

    local hi = range(0, 4):uint()
    local lo = range(4, 4):uint()
    return string.format("0x%08x%08x", hi, lo)
end

local function path_status_names(status)
    local names = {}
    for _, item in ipairs(PATH_STATUS_BITS) do
        if (status & item[1]) ~= 0 then
            table.insert(names, item[2])
        end
    end
    if #names == 0 then
        return tostring(status)
    end
    return table.concat(names, "|")
end

local function call_bgp(tvb, pinfo, tree, offset, length, label)
    local safe_len = bounded_len(tvb, offset, length, tvb:len())
    local node = tree:add(bmp20, tvb(offset, safe_len), label)
    if bgp_dissector and safe_len > 0 then
        bgp_dissector:call(tvb(offset, safe_len):tvb(), pinfo, node)
    else
        node:add(f.tlv_value, tvb(offset, safe_len))
    end
end

local function parse_bgp_message_at(tvb, pinfo, tree, offset, limit, label)
    if offset + 19 > limit then
        tree:add(bmp20, tvb(offset, math.max(0, limit - offset)), label .. " (truncated)")
        return limit
    end

    local bgp_len = tvb(offset + 16, 2):uint()
    if bgp_len < 19 or offset + bgp_len > limit then
        bgp_len = limit - offset
    end
    call_bgp(tvb, pinfo, tree, offset, bgp_len, label)
    return offset + bgp_len
end

local function parse_peer_header(tvb, tree, offset, limit)
    if offset + 42 > limit then
        tree:add(bmp20, tvb(offset, math.max(0, limit - offset)), "Per-Peer Header (truncated)")
        return limit, nil
    end

    local peer_tree = tree:add(bmp20, tvb(offset, 42), "Per-Peer Header")
    local peer_type = tvb(offset, 1):uint()
    local peer_flags = tvb(offset + 1, 1):uint()
    peer_tree:add(f.peer_type, tvb(offset, 1))
    peer_tree:add(f.peer_flags, tvb(offset + 1, 1))
    peer_tree:add(f.peer_rd, tvb(offset + 2, 8))

    local addr_offset = offset + 10
    if peer_type == 3 then
        peer_tree:add(f.tlv_value, tvb(addr_offset, 16)):set_text("Peer Address: 0.0.0.0 (Loc-RIB)")
    elseif (peer_flags & 0x80) ~= 0 then
        peer_tree:add(f.peer_addr_v6, tvb(addr_offset, 16))
    else
        peer_tree:add(f.peer_addr_v4, tvb(addr_offset + 12, 4))
    end

    peer_tree:add(f.peer_as, tvb(offset + 26, 4))
    peer_tree:add(f.peer_bgp_id, tvb(offset + 30, 4))
    peer_tree:add(f.peer_ts_sec, tvb(offset + 34, 4))
    peer_tree:add(f.peer_ts_usec, tvb(offset + 38, 4))
    return offset + 42, {
        peer_type = peer_type,
        peer_flags = peer_flags,
    }
end

local function parse_stat_records(tvb, tree, offset, limit)
    if offset + 4 > limit then
        tree:add(f.tlv_value, tvb(offset, math.max(0, limit - offset))):set_text("Stats: truncated count")
        return limit
    end

    local count = tvb(offset, 4):uint()
    local stats_tree = tree:add(bmp20, tvb(offset, limit - offset), "Stats")
    stats_tree:add(f.stats_count, tvb(offset, 4))
    offset = offset + 4

    for i = 1, count do
        if offset + 4 > limit then
            stats_tree:add(f.tlv_value, tvb(offset, math.max(0, limit - offset))):set_text("Stat " .. i .. ": truncated header")
            return limit
        end

        local stat_type = tvb(offset, 2):uint()
        local stat_len = tvb(offset + 2, 2):uint()
        local stat_end = math.min(offset + 4 + stat_len, limit)
        local stat_tree = stats_tree:add(bmp20, tvb(offset, stat_end - offset), "Stat " .. i .. ": " .. (STATS_NAMES[stat_type] or ("Unknown " .. stat_type)))
        stat_tree:add(f.stat_type, tvb(offset, 2))
        stat_tree:add(f.stat_length, tvb(offset + 2, 2))
        local value_offset = offset + 4
        local value_len = stat_end - value_offset
        if value_len == 4 then
            stat_tree:add(f.stat_value32, tvb(value_offset, 4))
        elseif value_len == 8 then
            stat_tree:add(f.stat_value64, tvb(value_offset, 8), uint64_to_string(tvb(value_offset, 8)))
        elseif PER_AFI_SAFI_STATS_TYPES[stat_type] and value_len == 11 then
            stat_tree:add(f.stat_afi, tvb(value_offset, 2))
            stat_tree:add(f.stat_safi, tvb(value_offset + 2, 1))
            stat_tree:add(f.stat_value64, tvb(value_offset + 3, 8), uint64_to_string(tvb(value_offset + 3, 8)))
        elseif value_len > 0 then
            stat_tree:add(f.tlv_value, tvb(value_offset, value_len))
        end
        offset = offset + 4 + stat_len
        if offset > limit then
            return limit
        end
    end

    return offset
end

local function parse_capabilities(tvb, tree, offset, limit)
    local cap_index = 1
    while offset + 2 <= limit do
        local cap_start = offset
        local code = tvb(offset, 1):uint()
        local length = tvb(offset + 1, 1):uint()
        local cap_end = math.min(offset + 2 + length, limit)
        local cap_tree = tree:add(bmp20, tvb(cap_start, cap_end - cap_start), "Capability " .. cap_index)
        cap_tree:add(f.cap_code, tvb(offset, 1))
        cap_tree:add(f.cap_length, tvb(offset + 1, 1))
        if cap_end > offset + 2 then
            if code == 0x45 then
                local tuple_offset = offset + 2
                local tuple_index = 1
                while tuple_offset + 4 <= cap_end do
                    local tuple_tree = cap_tree:add(bmp20, tvb(tuple_offset, 4), "ADD-PATH Tuple " .. tuple_index)
                    tuple_tree:add(f.add_path_afi, tvb(tuple_offset, 2))
                    tuple_tree:add(f.add_path_safi, tvb(tuple_offset + 2, 1))
                    tuple_tree:add(f.add_path_mode, tvb(tuple_offset + 3, 1))
                    tuple_offset = tuple_offset + 4
                    tuple_index = tuple_index + 1
                end
                if tuple_offset < cap_end then
                    cap_tree:add(f.tlv_value, tvb(tuple_offset, cap_end - tuple_offset)):set_text("Truncated ADD-PATH tuple")
                end
            else
                cap_tree:add(f.tlv_value, tvb(offset + 2, cap_end - offset - 2))
            end
        end
        offset = offset + 2 + length
        cap_index = cap_index + 1
        if offset > limit then
            return limit
        end
    end
    return offset
end

local function parse_tlvs(tvb, pinfo, tree, offset, limit, context, indexed)
    local tlvs_tree = tree:add(bmp20, tvb(offset, math.max(0, limit - offset)), "TLVs")
    local tlv_index = 1

    while offset < limit do
        local tlv_start = offset
        local header_len = indexed and 6 or 4
        if offset + header_len > limit then
            tlvs_tree:add(bmp20, tvb(offset, limit - offset), "Malformed TLV: truncated header")
            return limit
        end

        local raw_type = tvb(offset, 2):uint()
        local enterprise = (raw_type & 0x8000) ~= 0
        local tlv_type = raw_type & 0x7fff
        local length = tvb(offset + 2, 2):uint()
        offset = offset + 4

        local raw_index = nil
        local index = nil
        if indexed then
            raw_index = tvb(offset, 2):uint()
            index = raw_index & 0x7fff
            offset = offset + 2
        end

        local raw_value_offset = offset
        local raw_value_end = math.min(offset + length, limit)
        local value_offset = raw_value_offset
        local value_len = raw_value_end - raw_value_offset
        local name = context == "route" and route_tlv_name(tlv_type) or generic_tlv_name(tlv_type, context)
        if context == "stats" and tlv_type == 1 then
            name = "Stats"
        end

        local tlv_tree = tlvs_tree:add(bmp20, tvb(tlv_start, raw_value_end - tlv_start), "TLV " .. tlv_index .. ": " .. name)
        tlv_tree:add(f.tlv_raw_type, tvb(tlv_start, 2))
        tlv_tree:add(f.tlv_enterprise, tvb(tlv_start, 2))
        tlv_tree:add(f.tlv_type, tvb(tlv_start, 2), tlv_type)
        tlv_tree:add(f.tlv_length, tvb(tlv_start + 2, 2))

        if indexed and raw_index ~= nil then
            tlv_tree:add(f.tlv_raw_index, tvb(tlv_start + 4, 2))
            tlv_tree:add(f.tlv_group, tvb(tlv_start + 4, 2))
            tlv_tree:add(f.tlv_index, tvb(tlv_start + 4, 2), index)
        end

        if enterprise then
            if value_len >= 4 then
                tlv_tree:add(f.tlv_pen, tvb(value_offset, 4))
                value_offset = value_offset + 4
                value_len = raw_value_end - value_offset
            else
                tlv_tree:add(f.tlv_value, tvb(raw_value_offset, value_len)):set_text("Enterprise TLV value too short")
            end
        end

        if value_len > 0 then
            local kind = context == "route" and route_tlv_kind(tlv_type) or nil
            if context == "route" and kind == "bgp" then
                call_bgp(tvb, pinfo, tlv_tree, value_offset, value_len, "BGP Message")
            elseif context == "route" and kind == "stateless" then
                parse_capabilities(tvb, tlv_tree, value_offset, raw_value_end)
            elseif context == "route" and kind == "group" then
                local group_offset = value_offset
                local group_index = 1
                while group_offset + 2 <= raw_value_end do
                    local raw_group_index = tvb(group_offset, 2):uint()
                    local group_item = tlv_tree:add(bmp20, tvb(group_offset, 2), "Group NLRI Index " .. group_index)
                    group_item:add(f.group_raw_index, tvb(group_offset, 2))
                    group_item:add(f.group_index, tvb(group_offset, 2), raw_group_index & 0x7fff)
                    group_offset = group_offset + 2
                    group_index = group_index + 1
                end
                if group_offset < raw_value_end then
                    tlv_tree:add(f.tlv_value, tvb(group_offset, raw_value_end - group_offset)):set_text("Truncated Group index")
                end
            elseif context == "route" and kind == "path_marking" and value_len >= 4 then
                local status = tvb(value_offset, 4):uint()
                tlv_tree:add(f.path_status, tvb(value_offset, 4))
                tlv_tree:add(f.path_status_names, tvb(value_offset, 4), path_status_names(status))
                if value_len >= 6 then
                    local reason = tvb(value_offset + 4, 2):uint()
                    tlv_tree:add(f.path_reason, tvb(value_offset + 4, 2))
                    tlv_tree:add(f.path_reason_name, tvb(value_offset + 4, 2), PATH_STATUS_REASONS[reason] or ("Unknown " .. reason))
                end
            elseif context == "stats" and tlv_type == 1 then
                parse_stat_records(tvb, tlv_tree, value_offset, raw_value_end)
            elseif is_text_tlv(context, tlv_type) then
                tlv_tree:add(f.tlv_value, tvb(value_offset, value_len))
                add_text_if_printable(tlv_tree, tvb, value_offset, value_len)
            elseif tlv_type == 1 and value_len == 4 then
                tlv_tree:add(f.tlv_sequence, tvb(value_offset, 4))
            elseif tlv_type == 2 and value_len > 0 then
                tlv_tree:add(f.tlv_flags, tvb(value_offset, 1))
                if value_len > 1 then
                    tlv_tree:add(f.tlv_value, tvb(value_offset + 1, value_len - 1))
                end
            elseif tlv_type == 3 and value_len >= 8 then
                tlv_tree:add(f.tlv_ts_sec, tvb(value_offset, 4))
                tlv_tree:add(f.tlv_ts_usec, tvb(value_offset + 4, 4))
                if value_len > 8 then
                    tlv_tree:add(f.tlv_value, tvb(value_offset + 8, value_len - 8))
                end
            else
                tlv_tree:add(f.tlv_value, tvb(value_offset, value_len))
            end
        end

        offset = raw_value_offset + length
        tlv_index = tlv_index + 1
        if offset > limit then
            return limit
        end
    end

    return offset
end

local function dissect_message(tvb, pinfo, tree)
    local msg_len = tvb(1, 4):uint()
    local msg_type = tvb(5, 1):uint()
    local root = tree:add(bmp20, tvb(0, msg_len), "BMP v4 draft-20: " .. msg_name(msg_type))
    root:add(f.version, tvb(0, 1))
    root:add(f.length, tvb(1, 4))
    root:add(f.msg_type, tvb(5, 1))

    local offset = 6
    local limit = math.min(msg_len, tvb:len())

    if msg_type == 0 or msg_type == 6 then
        offset = parse_peer_header(tvb, root, offset, limit)
        parse_tlvs(tvb, pinfo, root, offset, limit, "route", true)
    elseif msg_type == 1 then
        offset = parse_peer_header(tvb, root, offset, limit)
        if get_v4_tlv_draft() == 20 then
            parse_tlvs(tvb, pinfo, root, offset, limit, "stats", false)
        elseif offset < limit then
            parse_stat_records(tvb, root, offset, limit)
        end
    elseif msg_type == 2 then
        offset = parse_peer_header(tvb, root, offset, limit)
        if offset < limit then
            local reason = tvb(offset, 1):uint()
            root:add(f.peer_down_reason, tvb(offset, 1))
            offset = offset + 1
            if reason == 1 or reason == 3 then
                offset = parse_bgp_message_at(tvb, pinfo, root, offset, limit, "BGP Notification")
            elseif reason == 2 then
                if offset + 2 <= limit then
                    root:add(f.fsm_event_code, tvb(offset, 2))
                    offset = offset + 2
                else
                    root:add(f.tlv_value, tvb(offset, math.max(0, limit - offset))):set_text("FSM Event Code (truncated)")
                    offset = limit
                end
            end

            if offset < limit then
                parse_tlvs(tvb, pinfo, root, offset, limit, "peer-down", false)
            end
        end
    elseif msg_type == 3 then
        local peer
        offset, peer = parse_peer_header(tvb, root, offset, limit)
        if offset + 20 <= limit then
            if peer and peer.peer_type == 3 then
                root:add(f.tlv_value, tvb(offset, 16)):set_text("Local Address: 0.0.0.0 (Loc-RIB)")
            elseif peer and (peer.peer_flags & 0x80) ~= 0 then
                root:add(f.local_addr_v6, tvb(offset, 16))
            else
                root:add(f.local_addr_v4, tvb(offset + 12, 4))
            end
            root:add(f.local_port, tvb(offset + 16, 2))
            root:add(f.remote_port, tvb(offset + 18, 2))
            offset = offset + 20
            offset = parse_bgp_message_at(tvb, pinfo, root, offset, limit, "Received BGP OPEN")
            offset = parse_bgp_message_at(tvb, pinfo, root, offset, limit, "Sent BGP OPEN")
            if offset < limit then
                parse_tlvs(tvb, pinfo, root, offset, limit, "peer-up", false)
            end
        end
    elseif msg_type == 4 or msg_type == 5 then
        parse_tlvs(tvb, pinfo, root, offset, limit, msg_type == 4 and "initiation" or "termination", false)
    elseif offset < limit then
        root:add(f.tlv_value, tvb(offset, limit - offset))
    end
end

function bmp20.dissector(tvb, pinfo, tree)
    local packet_len = tvb:len()
    local offset = 0

    if packet_len < 6 then
        pinfo.desegment_offset = 0
        pinfo.desegment_len = DESEGMENT_ONE_MORE_SEGMENT
        return
    end

    while offset < packet_len do
        if packet_len - offset < 6 then
            pinfo.desegment_offset = offset
            pinfo.desegment_len = DESEGMENT_ONE_MORE_SEGMENT
            return
        end

        local version = tvb(offset, 1):uint()
        if version ~= 4 then
            return 0
        end

        local msg_len = tvb(offset + 1, 4):uint()
        if msg_len < 6 then
            return 0
        end

        if packet_len - offset < msg_len then
            pinfo.desegment_offset = offset
            pinfo.desegment_len = msg_len - (packet_len - offset)
            return
        end

        pinfo.cols.protocol = "BMPv4-20"
        dissect_message(tvb(offset, msg_len):tvb(), pinfo, tree)
        offset = offset + msg_len
    end
end

local function register_port(port)
    if port ~= nil and port > 0 and tcp_table ~= nil then
        tcp_table:add(port, bmp20)
        registered_port = port
    end
end

register_port(bmp20.prefs.tcp_port)

if tcp_table ~= nil and tcp_table.add_for_decode_as ~= nil then
    pcall(function()
        tcp_table:add_for_decode_as(bmp20)
    end)
end

function bmp20.prefs_changed()
    if tcp_table == nil then
        return
    end
    if registered_port ~= nil then
        pcall(function()
            tcp_table:remove(registered_port, bmp20)
        end)
        registered_port = nil
    end
    register_port(bmp20.prefs.tcp_port)
end
