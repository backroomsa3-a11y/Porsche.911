/**
 * Persistent Message Archive
 * A production-quality Rain/Revenge plugin that locally archives messages,
 * tracks edits, and preserves deleted messages with a searchable UI.
 * 
 * Compatible with: Revenge / Rain / Vendetta (spec-compliant)
 * Storage: Uses @vendetta/plugin storage (IndexedDB-backed, survives restarts)
 */

import { findByStoreName, findByProps } from "@vendetta/metro";
import { before, after } from "@vendetta/patcher";
import { React, FluxDispatcher } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { Forms, General } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";
import { getAssetIDByName } from "@vendetta/ui/assets";

const { ScrollView, View, Text, TextInput, TouchableOpacity, Image, FlatList } = General;
const { FormSection, FormRow, FormSwitch, FormDivider, FormRadioRow } = Forms;

// ─── STORAGE INITIALIZATION ───
const DEFAULTS = {
    messages: {},        // { messageId: ArchiveMessage }
    settings: {
        retentionDays: 0, // 0 = unlimited, 7, 30, 90
        maxMessages: 10000,
        enabled: true,
        showDeletedBadge: true,
        showEditedBadge: true,
        enableAutoCleanup: false
    },
    stats: {
        totalArchived: 0,
        totalDeleted: 0,
        totalEdited: 0,
        lastCleanup: null
    }
};

if (!storage.pma) storage.pma = JSON.parse(JSON.stringify(DEFAULTS));
const pma = () => storage.pma;

// ─── TYPE DEFINITIONS (for reference) ───
// ArchiveMessage: {
//   id, authorId, authorName, authorDisplayName, authorAvatar,
//   guildId, guildName, channelId, channelName, threadId, threadName,
//   content, timestamp, editedTimestamp, isDeleted, isEdited,
//   editHistory: [{ content, timestamp }],
//   replyTo, attachments: [], embeds: [], reactions: [],
//   archivedAt, deletedAt
// }

// ─── HELPERS ───
const MessageStore = findByStoreName("MessageStore");
const ChannelStore = findByStoreName("ChannelStore");
const GuildStore = findByStoreName("GuildStore");
const UserStore = findByStoreName("UserStore");

function getGuildName(guildId) {
    if (!guildId) return "Direct Message";
    return GuildStore?.getGuild?.(guildId)?.name || "Unknown Server";
}

function getChannelName(channelId) {
    const channel = ChannelStore?.getChannel?.(channelId);
    if (!channel) return "Unknown Channel";
    return channel.name || (channel.recipients ? "DM" : "Unknown");
}

function getUserInfo(userId) {
    const user = UserStore?.getUser?.(userId);
    if (!user) return { name: "Unknown", displayName: "Unknown", avatar: null };
    return {
        name: user.username,
        displayName: user.globalName || user.username,
        avatar: user.avatar
    };
}

function formatDate(isoString) {
    if (!isoString) return "Unknown";
    const d = new Date(isoString);
    return d.toLocaleString("en-US", {
        month: "long", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
    });
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// ─── ARCHIVE CORE ───
function archiveMessage(msg) {
    const data = pma();
    if (!data.settings.enabled) return;

    const existing = data.messages[msg.id];
    const user = getUserInfo(msg.author?.id);
    const guildName = getGuildName(msg.guild_id);
    const channelName = getChannelName(msg.channel_id);

    // Handle edit
    if (existing && msg.content !== existing.content) {
        if (!existing.editHistory) existing.editHistory = [];
        existing.editHistory.push({
            content: existing.content,
            timestamp: existing.editedTimestamp || existing.timestamp
        });
        existing.content = msg.content;
        existing.editedTimestamp = msg.edited_timestamp || new Date().toISOString();
        existing.isEdited = true;
        data.stats.totalEdited++;
        storage.pma = data;
        return;
    }

    // Skip if already archived (and not an edit)
    if (existing) return;

    // Enforce max messages
    const msgIds = Object.keys(data.messages);
    if (msgIds.length >= data.settings.maxMessages) {
        // Remove oldest
        const oldest = msgIds.sort((a, b) => 
            new Date(data.messages[a].archivedAt) - new Date(data.messages[b].archivedAt)
        )[0];
        delete data.messages[oldest];
    }

    const record = {
        id: msg.id,
        authorId: msg.author?.id || "unknown",
        authorName: user.name,
        authorDisplayName: user.displayName,
        authorAvatar: user.avatar,
        guildId: msg.guild_id || null,
        guildName: guildName,
        channelId: msg.channel_id,
        channelName: channelName,
        threadId: msg.thread?.id || null,
        threadName: msg.thread?.name || null,
        content: msg.content || "",
        timestamp: msg.timestamp,
        editedTimestamp: msg.edited_timestamp || null,
        isDeleted: false,
        isEdited: false,
        editHistory: [],
        replyTo: msg.message_reference ? {
            messageId: msg.message_reference.message_id,
            channelId: msg.message_reference.channel_id,
            guildId: msg.message_reference.guild_id
        } : null,
        attachments: (msg.attachments || []).map(a => ({
            id: a.id, filename: a.filename, url: a.url, size: a.size, contentType: a.content_type
        })),
        embeds: (msg.embeds || []).map(e => ({
            title: e.title, description: e.description, url: e.url, type: e.type
        })),
        reactions: (msg.reactions || []).map(r => ({
            emoji: r.emoji?.name, count: r.count, me: r.me
        })),
        archivedAt: new Date().toISOString(),
        deletedAt: null
    };

    data.messages[msg.id] = record;
    data.stats.totalArchived++;
    storage.pma = data;
}

function markDeleted(msgId) {
    const data = pma();
    const msg = data.messages[msgId];
    if (!msg || msg.isDeleted) return;
    msg.isDeleted = true;
    msg.deletedAt = new Date().toISOString();
    data.stats.totalDeleted++;
    storage.pma = data;
}

function runCleanup() {
    const data = pma();
    const retention = data.settings.retentionDays;
    if (retention <= 0) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retention);

    let removed = 0;
    for (const [id, msg] of Object.entries(data.messages)) {
        if (new Date(msg.archivedAt) < cutoff) {
            delete data.messages[id];
            removed++;
        }
    }

    data.stats.lastCleanup = new Date().toISOString();
    storage.pma = data;
    if (removed > 0) showToast(`Cleaned up ${removed} old messages`);
}

// ─── PATCHES ───
let patches = [];

export default {
    onLoad() {
        // Hook MESSAGE_CREATE
        patches.push(before("dispatch", FluxDispatcher, ([event]) => {
            if (!event?.type) return;

            if (event.type === "MESSAGE_CREATE") {
                try {
                    archiveMessage(event.message);
                } catch (e) {
                    console.error("[PMA] Archive error:", e);
                }
            }

            if (event.type === "MESSAGE_UPDATE") {
                try {
                    archiveMessage(event.message);
                } catch (e) {
                    console.error("[PMA] Edit archive error:", e);
                }
            }

            if (event.type === "MESSAGE_DELETE" || event.type === "MESSAGE_DELETE_BULK") {
                try {
                    if (event.type === "MESSAGE_DELETE") {
                        markDeleted(event.id);
                    } else if (event.ids) {
                        event.ids.forEach(markDeleted);
                    }
                } catch (e) {
                    console.error("[PMA] Delete mark error:", e);
                }
            }
        }));

        // Initial cleanup
        runCleanup();
        showToast("📦 Persistent Message Archive loaded");
    },

    onUnload() {
        patches.forEach(p => p?.());
        patches = [];
        showToast("📦 Persistent Message Archive unloaded");
    },

    settings: ArchiveUI
};

// ─── UI COMPONENTS ───

function ArchiveUI() {
    const [tab, setTab] = React.useState("all"); // all | deleted | edited | search
    const [searchQuery, setSearchQuery] = React.useState("");
    const [filterUser, setFilterUser] = React.useState("");
    const [filterServer, setFilterServer] = React.useState("");
    const [filterChannel, setFilterChannel] = React.useState("");
    const [selectedMsg, setSelectedMsg] = React.useState(null);
    const [showSettings, setShowSettings] = React.useState(false);
    const [refreshKey, setRefreshKey] = React.useState(0);

    const data = pma();
    const messages = Object.values(data.messages);

    // Filter logic
    let filtered = messages;

    if (tab === "deleted") filtered = filtered.filter(m => m.isDeleted);
    if (tab === "edited") filtered = filtered.filter(m => m.isEdited);

    if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        filtered = filtered.filter(m =>
            m.content.toLowerCase().includes(q) ||
            m.id.includes(q) ||
            m.authorName.toLowerCase().includes(q)
        );
    }

    if (filterUser.trim()) {
        const q = filterUser.toLowerCase();
        filtered = filtered.filter(m =>
            m.authorName.toLowerCase().includes(q) ||
            m.authorId.includes(q)
        );
    }

    if (filterServer.trim()) {
        const q = filterServer.toLowerCase();
        filtered = filtered.filter(m =>
            (m.guildName || "").toLowerCase().includes(q)
        );
    }

    if (filterChannel.trim()) {
        const q = filterChannel.toLowerCase();
        filtered = filtered.filter(m =>
            (m.channelName || "").toLowerCase().includes(q)
        );
    }

    // Sort by timestamp desc
    filtered = filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const stats = data.stats;

    if (showSettings) {
        return React.createElement(SettingsPanel, { onBack: () => setShowSettings(false) });
    }

    if (selectedMsg) {
        return React.createElement(MessageDetail, { msg: selectedMsg, onBack: () => setSelectedMsg(null) });
    }

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: "#090C14" } },
        // Header
        React.createElement(View, { style: { padding: 16, borderBottomWidth: 1, borderBottomColor: "#1A2742" } },
            React.createElement(Text, { style: { color: "#F4F7FC", fontSize: 20, fontWeight: "700" } }, "📦 Message Archive"),
            React.createElement(Text, { style: { color: "#8EA3C7", fontSize: 12, marginTop: 4 } },
                `${messages.length} total · ${stats.totalDeleted} deleted · ${stats.totalEdited} edited`
            )
        ),

        // Tab Bar
        React.createElement(View, { style: { flexDirection: "row", padding: 8, borderBottomWidth: 1, borderBottomColor: "#1A2742" } },
            TabButton("All", "all", tab, setTab),
            TabButton("Deleted", "deleted", tab, setTab),
            TabButton("Edited", "edited", tab, setTab),
            TabButton("Search", "search", tab, setTab)
        ),

        // Search / Filters
        (tab === "search" || searchQuery || filterUser || filterServer || filterChannel) &&
        React.createElement(View, { style: { padding: 12, gap: 8 } },
            React.createElement(TextInput, {
                style: inputStyle,
                placeholder: "🔍 Search content, ID, or username...",
                placeholderTextColor: "#69768A",
                value: searchQuery,
                onChangeText: setSearchQuery
            }),
            React.createElement(TextInput, {
                style: inputStyle,
                placeholder: "👤 Filter by user...",
                placeholderTextColor: "#69768A",
                value: filterUser,
                onChangeText: setFilterUser
            }),
            React.createElement(TextInput, {
                style: inputStyle,
                placeholder: "🏠 Filter by server...",
                placeholderTextColor: "#69768A",
                value: filterServer,
                onChangeText: setFilterServer
            }),
            React.createElement(TextInput, {
                style: inputStyle,
                placeholder: "#️⃣ Filter by channel...",
                placeholderTextColor: "#69768A",
                value: filterChannel,
                onChangeText: setFilterChannel
            })
        ),

        // Message List
        React.createElement(View, { style: { padding: 8 } },
            filtered.length === 0 &&
            React.createElement(View, { style: { padding: 40, alignItems: "center" } },
                React.createElement(Text, { style: { color: "#69768A", fontSize: 14 } }, "No messages found")
            ),
            filtered.map(msg => MessageCard(msg, setSelectedMsg))
        ),

        // Bottom Actions
        React.createElement(View, { style: { padding: 12, borderTopWidth: 1, borderTopColor: "#1A2742" } },
            React.createElement(TouchableOpacity, {
                style: { padding: 12, backgroundColor: "#1A2742", borderRadius: 8, alignItems: "center" },
                onPress: () => setShowSettings(true)
            }, React.createElement(Text, { style: { color: "#5FA7FF", fontWeight: "600" } }, "⚙️ Settings & Export"))
        )
    );
}

function TabButton(label, key, active, setTab) {
    const isActive = active === key;
    return React.createElement(TouchableOpacity, {
        onPress: () => setTab(key),
        style: {
            flex: 1,
            paddingVertical: 8,
            marginHorizontal: 4,
            borderRadius: 6,
            backgroundColor: isActive ? "#3D74D9" : "transparent",
            alignItems: "center"
        }
    }, React.createElement(Text, { style: { color: isActive ? "#F4F7FC" : "#8EA3C7", fontSize: 12, fontWeight: "600" } }, label));
}

const inputStyle = {
    backgroundColor: "#121A2D",
    color: "#F4F7FC",
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: "#1A2742"
};

function MessageCard(msg, onPress) {
    const avatarUrl = msg.authorAvatar
        ? `https://cdn.discordapp.com/avatars/${msg.authorId}/${msg.authorAvatar}.png`
        : null;

    const badges = [];
    if (msg.isDeleted) badges.push("🗑️ DELETED");
    if (msg.isEdited) badges.push("✏️ EDITED");

    return React.createElement(TouchableOpacity, {
        key: msg.id,
        style: {
            backgroundColor: msg.isDeleted ? "#7A233122" : "#121A2D",
            borderRadius: 10,
            padding: 12,
            marginBottom: 8,
            borderWidth: 1,
            borderColor: msg.isDeleted ? "#B5502A" : "#1A2742"
        },
        onPress: () => onPress(msg)
    },
        // Badges row
        badges.length > 0 && React.createElement(View, { style: { flexDirection: "row", marginBottom: 6, gap: 6 } },
            badges.map(b => React.createElement(Text, {
                key: b,
                style: { color: "#E0AC50", fontSize: 10, fontWeight: "700" }
            }, b))
        ),

        // Author row
        React.createElement(View, { style: { flexDirection: "row", alignItems: "center", marginBottom: 6 } },
            avatarUrl && React.createElement(Image, {
                source: { uri: avatarUrl },
                style: { width: 32, height: 32, borderRadius: 16, marginRight: 10 }
            }),
            React.createElement(View, { style: { flex: 1 } },
                React.createElement(Text, { style: { color: "#F4F7FC", fontSize: 14, fontWeight: "600" } },
                    msg.authorDisplayName || msg.authorName
                ),
                React.createElement(Text, { style: { color: "#69768A", fontSize: 11 } },
                    `@${msg.authorName} · ${formatDate(msg.timestamp)}`
                )
            )
        ),

        // Location
        React.createElement(Text, { style: { color: "#8EA3C7", fontSize: 11, marginBottom: 6 } },
            `${msg.guildName} › #${msg.channelName}`
        ),

        // Content preview
        React.createElement(Text, {
            style: {
                color: msg.isDeleted ? "#69768A" : "#D8E2F2",
                fontSize: 13,
                lineHeight: 18
            },
            numberOfLines: 3
        }, msg.content || "(no content)"),

        // Footer
        React.createElement(View, { style: { flexDirection: "row", marginTop: 8, justifyContent: "space-between" } },
            React.createElement(Text, { style: { color: "#69768A", fontSize: 10 } }, `ID: ${msg.id.slice(0, 8)}...`),
            msg.attachments?.length > 0 && React.createElement(Text, { style: { color: "#5FA7FF", fontSize: 10 } }, `📎 ${msg.attachments.length}`),
            msg.reactions?.length > 0 && React.createElement(Text, { style: { color: "#5FA7FF", fontSize: 10 } }, `😀 ${msg.reactions.length}`)
        )
    );
}

function MessageDetail({ msg, onBack }) {
    const avatarUrl = msg.authorAvatar
        ? `https://cdn.discordapp.com/avatars/${msg.authorId}/${msg.authorAvatar}.png`
        : null;

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: "#090C14" } },
        // Header
        React.createElement(View, { style: { padding: 16, borderBottomWidth: 1, borderBottomColor: "#1A2742", flexDirection: "row", alignItems: "center" } },
            React.createElement(TouchableOpacity, { onPress: onBack, style: { marginRight: 12 } },
                React.createElement(Text, { style: { color: "#5FA7FF", fontSize: 16 } }, "← Back")
            ),
            React.createElement(Text, { style: { color: "#F4F7FC", fontSize: 16, fontWeight: "700" } }, "Message Detail")
        ),

        // Badges
        React.createElement(View, { style: { padding: 16, flexDirection: "row", gap: 8 } },
            msg.isDeleted && React.createElement(View, { style: { backgroundColor: "#7A2331", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4 } },
                React.createElement(Text, { style: { color: "#F4F7FC", fontSize: 11, fontWeight: "700" } }, "🗑️ DELETED")
            ),
            msg.isEdited && React.createElement(View, { style: { backgroundColor: "#C0862B", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4 } },
                React.createElement(Text, { style: { color: "#F4F7FC", fontSize: 11, fontWeight: "700" } }, "✏️ EDITED")
            )
        ),

        // Author
        React.createElement(View, { style: { paddingHorizontal: 16, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: "#1A2742" } },
            React.createElement(Text, { style: { color: "#8EA3C7", fontSize: 11, marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 } }, "User"),
            React.createElement(View, { style: { flexDirection: "row", alignItems: "center" } },
                avatarUrl && React.createElement(Image, { source: { uri: avatarUrl }, style: { width: 40, height: 40, borderRadius: 20, marginRight: 12 } }),
                React.createElement(View, { style: { flex: 1 } },
                    React.createElement(Text, { style: { color: "#F4F7FC", fontSize: 16, fontWeight: "600" } }, msg.authorDisplayName || msg.authorName),
                    React.createElement(Text, { style: { color: "#69768A", fontSize: 12 } }, `@${msg.authorName}`),
                    React.createElement(Text, { style: { color: "#69768A", fontSize: 11, marginTop: 2 } }, `ID: ${msg.authorId}`)
                )
            ),
            React.createElement(TouchableOpacity, {
                style: { marginTop: 8, alignSelf: "flex-start" },
                onPress: () => {
                    // Copy to clipboard
                    const { Clipboard } = require("@vendetta/metro/common");
                    Clipboard?.setString?.(msg.authorId);
                    showToast("User ID copied");
                }
            }, React.createElement(Text, { style: { color: "#5FA7FF", fontSize: 12 } }, "📋 Copy User ID"))
        ),

        // Location
        React.createElement(DetailSection("Location", [
            ["Server", msg.guildName],
            ["Channel", `#${msg.channelName}`],
            msg.threadName && ["Thread", msg.threadName]
        ]),

        // Timing
        React.createElement(DetailSection("Timing", [
            ["Sent", formatDate(msg.timestamp)],
            msg.editedTimestamp && ["Edited", formatDate(msg.editedTimestamp)],
            msg.deletedAt && ["Deleted", formatDate(msg.deletedAt)],
            ["Archived", formatDate(msg.archivedAt)]
        ]),

        // Content
        React.createElement(View, { style: { padding: 16, borderBottomWidth: 1, borderBottomColor: "#1A2742" } },
            React.createElement(Text, { style: { color: "#8EA3C7", fontSize: 11, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 } }, "Message Content"),
            React.createElement(View, { style: { backgroundColor: "#121A2D", borderRadius: 8, padding: 12 } },
                React.createElement(Text, { style: { color: "#D8E2F2", fontSize: 14, lineHeight: 20 } }, msg.content || "(no content)")
            ),
            React.createElement(TouchableOpacity, {
                style: { marginTop: 8 },
                onPress: () => {
                    const { Clipboard } = require("@vendetta/metro/common");
                    Clipboard?.setString?.(msg.content);
                    showToast("Content copied");
                }
            }, React.createElement(Text, { style: { color: "#5FA7FF", fontSize: 12 } }, "📋 Copy Content"))
        ),

        // Edit History
        msg.editHistory?.length > 0 && React.createElement(View, { style: { padding: 16, borderBottomWidth: 1, borderBottomColor: "#1A2742" } },
            React.createElement(Text, { style: { color: "#8EA3C7", fontSize: 11, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 } }, "Edit History"),
            msg.editHistory.map((edit, i) =>
                React.createElement(View, { key: i, style: { backgroundColor: "#121A2D", borderRadius: 8, padding: 10, marginBottom: 6 } },
                    React.createElement(Text, { style: { color: "#69768A", fontSize: 10, marginBottom: 4 } }, `Version ${i + 1} · ${formatDate(edit.timestamp)}`),
                    React.createElement(Text, { style: { color: "#D8E2F2", fontSize: 13 } }, edit.content)
                )
            )
        ),

        // Attachments
        msg.attachments?.length > 0 && React.createElement(View, { style: { padding: 16, borderBottomWidth: 1, borderBottomColor: "#1A2742" } },
            React.createElement(Text, { style: { color: "#8EA3C7", fontSize: 11, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 } }, `Attachments (${msg.attachments.length})`),
            msg.attachments.map(att =>
                React.createElement(View, { key: att.id, style: { backgroundColor: "#121A2D", borderRadius: 8, padding: 10, marginBottom: 6 } },
                    React.createElement(Text, { style: { color: "#5FA7FF", fontSize: 12 } }, att.filename),
                    React.createElement(Text, { style: { color: "#69768A", fontSize: 10 } }, `${(att.size / 1024).toFixed(1)} KB`)
                )
            )
        ),

        // Reactions
        msg.reactions?.length > 0 && React.createElement(View, { style: { padding: 16, borderBottomWidth: 1, borderBottomColor: "#1A2742" } },
            React.createElement(Text, { style: { color: "#8EA3C7", fontSize: 11, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 } }, "Reactions"),
            React.createElement(View, { style: { flexDirection: "row", flexWrap: "wrap", gap: 6 } },
                msg.reactions.map((r, i) =>
                    React.createElement(View, { key: i, style: { backgroundColor: "#121A2D", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 } },
                        React.createElement(Text, { style: { color: "#D8E2F2", fontSize: 12 } }, `${r.emoji} ${r.count}`)
                    )
                )
            )
        ),

        // Message ID & Actions
        React.createElement(View, { style: { padding: 16 } },
            React.createElement(Text, { style: { color: "#8EA3C7", fontSize: 11, marginBottom: 4 } }, "Message ID"),
            React.createElement(Text, { style: { color: "#69768A", fontSize: 12, marginBottom: 8 } }, msg.id),
            React.createElement(TouchableOpacity, {
                onPress: () => {
                    const { Clipboard } = require("@vendetta/metro/common");
                    Clipboard?.setString?.(msg.id);
                    showToast("Message ID copied");
                }
            }, React.createElement(Text, { style: { color: "#5FA7FF", fontSize: 12 } }, "📋 Copy Message ID"))
        )
    );
}

function DetailSection(title, rows) {
    return React.createElement(View, { style: { padding: 16, borderBottomWidth: 1, borderBottomColor: "#1A2742" } },
        React.createElement(Text, { style: { color: "#8EA3C7", fontSize: 11, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 } }, title),
        rows.filter(Boolean).map(([label, value]) =>
            React.createElement(View, { key: label, style: { flexDirection: "row", marginBottom: 4 } },
                React.createElement(Text, { style: { color: "#69768A", fontSize: 12, width: 80 } }, label),
                React.createElement(Text, { style: { color: "#D8E2F2", fontSize: 12, flex: 1 } }, value || "N/A")
            )
        )
    );
}

function SettingsPanel({ onBack }) {
    const data = pma();
    const [settings, setSettings] = React.useState({ ...data.settings });
    const [exporting, setExporting] = React.useState(false);

    const update = (key, val) => {
        settings[key] = val;
        data.settings = settings;
        storage.pma = data;
        setSettings({ ...settings });
    };

    const doExport = () => {
        try {
            const blob = JSON.stringify(data.messages, null, 2);
            const { Clipboard } = require("@vendetta/metro/common");
            Clipboard?.setString?.(blob);
            showToast(`Exported ${Object.keys(data.messages).length} messages to clipboard`);
        } catch (e) {
            showToast("Export failed");
        }
    };

    const doClear = () => {
        data.messages = {};
        data.stats = { totalArchived: 0, totalDeleted: 0, totalEdited: 0, lastCleanup: null };
        storage.pma = data;
        showToast("Archive cleared");
        setSettings({ ...settings });
    };

    const doCleanup = () => {
        runCleanup();
        showToast("Cleanup complete");
    };

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: "#090C14" } },
        React.createElement(View, { style: { padding: 16, borderBottomWidth: 1, borderBottomColor: "#1A2742", flexDirection: "row", alignItems: "center" } },
            React.createElement(TouchableOpacity, { onPress: onBack, style: { marginRight: 12 } },
                React.createElement(Text, { style: { color: "#5FA7FF", fontSize: 16 } }, "← Back")
            ),
            React.createElement(Text, { style: { color: "#F4F7FC", fontSize: 16, fontWeight: "700" } }, "Archive Settings")
        ),

        React.createElement(FormSection, { title: "General" },
            React.createElement(FormRow, {
                label: "Enable Archiving",
                trailing: React.createElement(FormSwitch, { value: settings.enabled, onValueChange: v => update("enabled", v) })
            }),
            React.createElement(FormRow, {
                label: "Show Deleted Badge",
                trailing: React.createElement(FormSwitch, { value: settings.showDeletedBadge, onValueChange: v => update("showDeletedBadge", v) })
            }),
            React.createElement(FormRow, {
                label: "Show Edited Badge",
                trailing: React.createElement(FormSwitch, { value: settings.showEditedBadge, onValueChange: v => update("showEditedBadge", v) })
            })
        ),

        React.createElement(FormDivider, null),

        React.createElement(FormSection, { title: "Retention" },
            React.createElement(Text, { style: { color: "#69768A", paddingHorizontal: 16, paddingBottom: 8, fontSize: 12 } },
                "Automatically remove messages older than the selected period."
            ),
            [0, 7, 30, 90].map(days =>
                React.createElement(FormRadioRow, {
                    key: days,
                    label: days === 0 ? "Unlimited" : `${days} Days`,
                    selected: settings.retentionDays === days,
                    onPress: () => update("retentionDays", days)
                })
            )
        ),

        React.createElement(FormDivider, null),

        React.createElement(FormSection, { title: "Actions" },
            React.createElement(FormRow, {
                label: "Run Cleanup Now",
                trailing: React.createElement(Text, { style: { color: "#5FA7FF" } }, "🧹"),
                onPress: doCleanup
            }),
            React.createElement(FormRow, {
                label: "Export to Clipboard (JSON)",
                trailing: React.createElement(Text, { style: { color: "#5FA7FF" } }, "📤"),
                onPress: doExport
            }),
            React.createElement(FormRow, {
                label: "Clear All Archive Data",
                trailing: React.createElement(Text, { style: { color: "#B5502A" } }, "🗑️"),
                onPress: doClear
            })
        ),

        React.createElement(FormDivider, null),

        React.createElement(FormSection, { title: "Statistics" },
            React.createElement(Text, { style: { color: "#D8E2F2", paddingHorizontal: 16, paddingVertical: 4 } },
                `Total Archived: ${data.stats.totalArchived}\nDeleted: ${data.stats.totalDeleted}\nEdited: ${data.stats.totalEdited}\nCurrently Stored: ${Object.keys(data.messages).length}`
            )
        )
    );
}
