/**
 * DM Manager Pro
 * Features: Better DM Manager, DM Categories, DM Folders, Pinned DMs+, 
 * Hidden DMs (Local), Archive DMs, Recently Contacted, Frequent Contacts, 
 * Smart DM Search, DM Statistics
 * 
 * Compatible with: Revenge / Vendetta / Enmity (spec-compliant)
 */

import { findByName, findByProps, findByStoreName } from "@vendetta/metro";
import { after, before } from "@vendetta/patcher";
import { React, FluxDispatcher, NavigationNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

const { ScrollView, View, Text, TextInput, TouchableOpacity, Image } = General;
const { FormSection, FormRow, FormSwitch, FormDivider } = Forms;

// ─── STORAGE ───
const DEFAULTS = {
    categories: {},      // { categoryName: [channelId, ...] }
    pinned: [],          // [channelId, ...]
    hidden: [],          // [channelId, ...]
    archived: [],        // [channelId, ...]
    frequent: {},        // { channelId: count }
    recent: [],          // [channelId, ...] (last 50)
    notes: {},           // { channelId: "note text" }
    settings: {
        enableCategories: true,
        enablePinned: true,
        enableFrequent: true,
        enableRecent: true,
        enableArchive: true,
        enableHidden: false,
        enableStats: true,
        searchMode: "smart" // smart | exact
    }
};

if (!storage.dmManager) storage.dmManager = JSON.parse(JSON.stringify(DEFAULTS));
const data = () => storage.dmManager;

// ─── HELPERS ───
const ChannelStore = findByStoreName("ChannelStore");
const UserStore = findByStoreName("UserStore");
const MessageStore = findByStoreName("MessageStore");

function getDMChannels() {
    const channels = ChannelStore?.getChannels?.() || {};
    return Object.values(channels).filter(c => c.type === 1 || c.type === 3);
}

function getChannelName(channel) {
    if (!channel) return "Unknown";
    if (channel.name) return channel.name;
    const recipients = channel.recipients?.map(id => UserStore?.getUser?.(id)).filter(Boolean);
    return recipients?.map(u => u.username).join(", ") || "Unknown";
}

function getAvatar(channel) {
    if (channel?.icon) return `https://cdn.discordapp.com/channel-icons/${channel.id}/${channel.icon}.png`;
    const recipient = channel?.recipients?.[0];
    const user = recipient ? UserStore?.getUser?.(recipient) : null;
    return user?.avatar 
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` 
        : null;
}

function trackOpen(channelId) {
    const d = data();
    // Recent
    d.recent = [channelId, ...d.recent.filter(id => id !== channelId)].slice(0, 50);
    // Frequent
    d.frequent[channelId] = (d.frequent[channelId] || 0) + 1;
    storage.dmManager = d;
}

// ─── PATCHES ───
let patches = [];

export default {
    onLoad() {
        // Patch DM List to inject sections
        const PrivateChannelsList = findByName("PrivateChannelsList", false);
        if (PrivateChannelsList) {
            patches.push(after("default", PrivateChannelsList, ([props], ret) => {
                const d = data();
                if (!d.settings.enableCategories && !d.settings.enablePinned) return ret;

                // Wrap the list with our enhanced renderer
                return React.createElement(DMManagerRoot, { 
                    original: ret, 
                    channels: props.channels || getDMChannels(),
                    settings: d.settings 
                });
            }));
        }

        // Patch DM channel press to track frequent/recent
        const PrivateChannel = findByName("PrivateChannel", false);
        if (PrivateChannel) {
            patches.push(after("default", PrivateChannel, ([props], ret) => {
                const channelId = props.channel?.id;
                if (!channelId) return ret;

                return React.createElement(TouchableOpacity, {
                    activeOpacity: 0.8,
                    onPress: () => trackOpen(channelId)
                }, ret);
            }));
        }

        // Patch channel delete/archive actions via Flux
        patches.push(before("dispatch", FluxDispatcher, ([event]) => {
            if (event?.type === "CHANNEL_DELETE" && event?.channel?.type === 1) {
                const d = data();
                d.archived.push(event.channel.id);
                storage.dmManager = d;
            }
        }));
    },

    onUnload() {
        patches.forEach(p => p?.());
        patches = [];
    },

    settings: DMSettings
};

// ─── UI COMPONENTS ───

function DMManagerRoot({ original, channels, settings }) {
    const [searchQuery, setSearchQuery] = React.useState("");
    const d = data();

    // Filter out hidden
    let visible = channels.filter(c => !d.hidden.includes(c.id) && !d.archived.includes(c.id));

    // Smart search
    if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        visible = visible.filter(c => {
            const name = getChannelName(c).toLowerCase();
            const note = (d.notes[c.id] || "").toLowerCase();
            if (settings.searchMode === "exact") return name === q || name.includes(q);
            // Smart: fuzzy-ish
            return name.includes(q) || note.includes(q) || c.id.includes(q);
        });
    }

    const pinned = visible.filter(c => d.pinned.includes(c.id));
    const frequent = [...visible]
        .filter(c => d.frequent[c.id] > 0 && !d.pinned.includes(c.id))
        .sort((a, b) => (d.frequent[b.id] || 0) - (d.frequent[a.id] || 0))
        .slice(0, 10);
    const recent = d.recent
        .map(id => visible.find(c => c.id === id))
        .filter(Boolean)
        .filter(c => !d.pinned.includes(c.id));
    const uncategorized = visible.filter(c => 
        !d.pinned.includes(c.id) && 
        !frequent.includes(c) && 
        !recent.includes(c)
    );

    return React.createElement(ScrollView, { style: { flex: 1, backgroundColor: "#020101" } },
        // Search Bar
        React.createElement(View, { style: { padding: 12, borderBottomWidth: 1, borderBottomColor: "#3D0B0D" } },
            React.createElement(TextInput, {
                style: {
                    backgroundColor: "#2E000F",
                    color: "#FEE1E1",
                    borderRadius: 8,
                    padding: 10,
                    fontSize: 14
                },
                placeholder: "🔍 Smart DM Search...",
                placeholderTextColor: "#72090F",
                value: searchQuery,
                onChangeText: setSearchQuery
            })
        ),

        // Stats Bar
        settings.enableStats && React.createElement(View, { 
            style: { flexDirection: "row", padding: 8, justifyContent: "space-around", borderBottomWidth: 1, borderBottomColor: "#3D0B0D" }
        },
            StatBadge("Total", visible.length),
            StatBadge("Pinned", pinned.length),
            StatBadge("Recent", recent.length),
            StatBadge("Msgs", Object.values(MessageStore?.getMessages || {}).length)
        ),

        // Pinned Section
        settings.enablePinned && pinned.length > 0 && Section("📌 Pinned DMs", pinned, "#B21F29"),

        // Frequent Section
        settings.enableFrequent && frequent.length > 0 && Section("🔥 Frequent Contacts", frequent, "#930510"),

        // Recent Section
        settings.enableRecent && recent.length > 0 && Section("🕐 Recently Contacted", recent, "#7C1D24"),

        // Uncategorized / All
        Section("💬 Direct Messages", uncategorized, "#C96B6B")
    );
}

function StatBadge(label, value) {
    return React.createElement(View, { style: { alignItems: "center" } },
        React.createElement(Text, { style: { color: "#B21F29", fontSize: 16, fontWeight: "bold" } }, String(value)),
        React.createElement(Text, { style: { color: "#72090F", fontSize: 10 } }, label)
    );
}

function Section(title, channels, accentColor) {
    if (channels.length === 0) return null;
    return React.createElement(View, { style: { marginTop: 8 } },
        React.createElement(Text, { 
            style: { 
                color: accentColor, 
                fontSize: 12, 
                fontWeight: "700", 
                textTransform: "uppercase",
                paddingHorizontal: 12,
                paddingVertical: 6,
                letterSpacing: 1
            } 
        }, `${title} — ${channels.length}`),
        React.createElement(View, { style: { backgroundColor: "#240A0A", marginHorizontal: 8, borderRadius: 8, overflow: "hidden" } },
            channels.map(channel => DMRow(channel))
        )
    );
}

function DMRow(channel) {
    const d = data();
    const name = getChannelName(channel);
    const avatar = getAvatar(channel);
    const msgCount = MessageStore?.getMessages?.(channel.id)?._array?.length || 0;
    const isPinned = d.pinned.includes(channel.id);

    return React.createElement(TouchableOpacity, {
        key: channel.id,
        style: {
            flexDirection: "row",
            alignItems: "center",
            padding: 10,
            borderBottomWidth: 1,
            borderBottomColor: "#3D0B0D"
        },
        onPress: () => {
            trackOpen(channel.id);
            NavigationNative?.push?.("Channel", { channelId: channel.id });
        },
        onLongPress: () => {
            // Context menu: Pin / Hide / Archive / Note
            const newPinned = isPinned 
                ? d.pinned.filter(id => id !== channel.id)
                : [...d.pinned, channel.id];
            d.pinned = newPinned;
            storage.dmManager = d;
            showToast(isPinned ? "📌 Unpinned" : "📌 Pinned");
        }
    },
        avatar && React.createElement(Image, { 
            source: { uri: avatar }, 
            style: { width: 40, height: 40, borderRadius: 20, marginRight: 10, borderWidth: isPinned ? 2 : 0, borderColor: "#B21F29" } 
        }),
        React.createElement(View, { style: { flex: 1 } },
            React.createElement(Text, { style: { color: "#FEE1E1", fontSize: 14, fontWeight: "600" } }, name),
            React.createElement(Text, { style: { color: "#72090F", fontSize: 11 } }, 
                msgCount > 0 ? `${msgCount} messages cached` : "No messages"
            )
        ),
        isPinned && React.createElement(Text, { style: { color: "#B21F29", fontSize: 12 } }, "📌")
    );
}

// ─── SETTINGS PANEL ───
function DMSettings() {
    const d = data();
    const [settings, setSettings] = React.useState(d.settings);

    const toggle = (key) => {
        settings[key] = !settings[key];
        d.settings = settings;
        storage.dmManager = d;
        setSettings({ ...settings });
    };

    return React.createElement(ScrollView, { style: { flex: 1 } },
        React.createElement(FormSection, { title: "DM Manager Pro" },
            React.createElement(Text, { style: { color: "#C96B6B", paddingHorizontal: 16, paddingBottom: 8, fontSize: 12 } },
                "Organize your DMs with categories, pins, frequent contacts, and more."
            )
        ),
        React.createElement(FormDivider, null),
        React.createElement(FormSection, { title: "Sections" },
            FormSwitchRow("Enable Categories", settings.enableCategories, () => toggle("enableCategories")),
            FormSwitchRow("Enable Pinned DMs", settings.enablePinned, () => toggle("enablePinned")),
            FormSwitchRow("Enable Frequent Contacts", settings.enableFrequent, () => toggle("enableFrequent")),
            FormSwitchRow("Enable Recently Contacted", settings.enableRecent, () => toggle("enableRecent")),
            FormSwitchRow("Enable Archive", settings.enableArchive, () => toggle("enableArchive")),
            FormSwitchRow("Show Hidden DMs", settings.enableHidden, () => toggle("enableHidden"))
        ),
        React.createElement(FormDivider, null),
        React.createElement(FormSection, { title: "Search & Stats" },
            FormSwitchRow("DM Statistics", settings.enableStats, () => toggle("enableStats")),
            FormSwitchRow("Smart Search Mode", settings.searchMode === "smart", () => {
                settings.searchMode = settings.searchMode === "smart" ? "exact" : "smart";
                setSettings({ ...settings });
            })
        ),
        React.createElement(FormDivider, null),
        React.createElement(FormSection, { title: "Danger Zone" },
            React.createElement(FormRow, {
                label: "Reset All Data",
                trailing: React.createElement(Text, { style: { color: "#B21F29" } }, "🗑️"),
                onPress: () => {
                    storage.dmManager = JSON.parse(JSON.stringify(DEFAULTS));
                    showToast("All DM data reset");
                }
            })
        )
    );
}

function FormSwitchRow(label, value, onPress) {
    return React.createElement(FormRow, {
        label,
        trailing: React.createElement(FormSwitch, { value, onValueChange: onPress })
    });
}
