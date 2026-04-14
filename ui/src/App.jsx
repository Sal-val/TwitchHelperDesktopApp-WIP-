import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import tmi from 'tmi.js';
import './App.css';

// --- CONFIGURATION ---
const CLIENT_ID = '1zqq64ujr84i1ljd3dsd2ikgxciiyw';
const REDIRECT_URI = 'http://localhost:8001';
const STORAGE_KEYS = {
  accessToken: 'twitch_token',
  channel: 'twitch_channel',
  historySas: 'history_sas',
  liveSas: 'live_sas'
};

function App() {
  // --- STATE: UI & NAVIGATION ---
  const [tab, setTab] = useState('raid-list');
  const [currentTime, setCurrentTime] = useState(Date.now());

  // --- STATE: CHAT & AZURE CLOUD ---
  const [history, setHistory] = useState([]);
  const [fullStreamerList, setFullStreamerList] = useState([]);
  const [session, setSession] = useState([]);
  const [editingAzureNote, setEditingAzureNote] = useState({ name: null, text: '' });
  const [azureEtag, setAzureEtag] = useState(null);

  // --- STATE: TWITCH API & EVENTSUB ---
  const [broadcasterId, setBroadcasterId] = useState(null);
  const [myUserId, setMyUserId] = useState(null);

  // --- STATE: RAID TRACKING (5% Logic) ---
  const [raidTrackers, setRaidTrackers] = useState({});

  // --- STATE: LOCAL NOTES ---
  const [localNotes, setLocalNotes] = useState([]);
  const [isCreatingNewNote, setIsCreatingNewNote] = useState(false);
  const [newNoteText, setNewNoteText] = useState('');
  const [editingLocalNoteId, setEditingLocalNoteId] = useState(null);
  const [editText, setEditText] = useState('');
  const newNoteRef = useRef(null);

  const [settings, setSettings] = useState({
    channel: localStorage.getItem('twitch_channel') || '',
    historySas: localStorage.getItem('history_sas') || '',
    liveSas: localStorage.getItem('live_sas') || '',
    accessToken: localStorage.getItem('twitch_token') || ''
  });

  // --- HELPERS ---
  const fetchWithRetry = useCallback(async (url, options = {}, retries = 5) => {
    const separator = url.includes('?') ? '&' : '?';
    const cacheBusterUrl = `${url}${separator}cb=${Date.now()}`;

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(cacheBusterUrl, options);
        if (response.status === 412) {
          await new Promise(res => setTimeout(res, 2000));
          continue;
        }
        return response;
      } catch (err) {
        if (i === retries - 1) throw err;
      }
    }
  }, []);

  const getUptime = (startTime) => {
    const start = new Date(startTime);
    const now = new Date();
    const diff = Math.floor((now - start) / 1000);
    const hours = Math.floor(diff / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  const loginWithTwitch = () => {
    const scopes = 'chat:read moderator:read:shoutouts';
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=token&scope=${scopes}&force_verify=true`;
    window.location.assign(url);
  };

  const updateSetting = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    localStorage.setItem(STORAGE_KEYS[key], value);
  };

  const copyText = (text, alertMsg) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text)
        .then(() => { if (alertMsg) alert(alertMsg); })
        .catch(() => fallbackCopyText(text, alertMsg));
    } else {
      fallbackCopyText(text, alertMsg);
    }
  };

  const fallbackCopyText = (text, alertMsg) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      if (alertMsg) alert(alertMsg);
    } catch (err) {
      console.error('Fallback copy failed', err);
    }
    document.body.removeChild(textArea);
  };

  // --- PERSISTENCE ---
  const saveShoutoutsToDisk = async (updatedSession) => {
    try {
      const dataToSave = updatedSession.map(s => ({
        ChannelName: s.name,
        RaidTime: s.time,
        ViewerCount: s.viewers,
        LastShoutoutSent: s.lastSO
      }));

      await fetch('/api/shoutouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dataToSave)
      });
      setSession(updatedSession);
    } catch (err) { console.error("Local Shoutout Disk Save failed:", err); }
  };

  const loadLocalShoutouts = useCallback(async () => {
    try {
      const response = await fetch('/api/shoutouts');
      if (response.ok) {
        const data = await response.json();
        const formatted = data.map(item => ({
          name: item.ChannelName,
          time: item.RaidTime,
          viewers: item.ViewerCount,
          lastSO: item.LastShoutoutSent || null
        }));
        setSession(formatted);
      }
    } catch (err) { console.error("Failed to load local shoutouts:", err); }
  }, []);

  const fetchLiveSessionFromCloud = useCallback(async () => {
    if (!settings.liveSas) return;
    try {
      const res = await fetchWithRetry(settings.liveSas);
      const cloudData = await res.json();
      const formatted = cloudData.map(item => ({
        name: item.ChannelName,
        time: item.RaidTime,
        viewers: item.ViewerCount,
        lastSO: item.LastShoutoutSent || null
      }));
      await saveShoutoutsToDisk(formatted);
    } catch (err) { console.error("Cloud Pull Failed:", err); }
  }, [settings.liveSas, fetchWithRetry]);

  // --- AZURE CLOUD SYNC ---
  const syncCloudData = useCallback(async (onlyLive = true) => {
    if (!settings.historySas || !settings.accessToken) return;
    try {
      const res = await fetchWithRetry(settings.historySas);
      const etag = res.headers.get('ETag');
      setAzureEtag(etag);
      const azureData = await res.json();

      const logins = azureData.map(c => c.ChannelName.toLowerCase());
      const queryParams = logins.map(login => `user_login=${login}`).join('&');

      const twitchRes = await fetch(`https://api.twitch.tv/helix/streams?${queryParams}`, {
        headers: { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${settings.accessToken}` }
      });
      const twitchData = await twitchRes.json();
      const liveStreams = twitchData.data || [];

      const mergedData = azureData.map(az => {
        const ls = liveStreams.find(s => s.user_login.toLowerCase() === az.ChannelName.toLowerCase());
        return {
          ...az,
          isLive: !!ls,
          Category: ls ? ls.game_name : 'Offline',
          Title: ls ? ls.title : '',
          Uptime: ls ? getUptime(ls.started_at) : null,
          LiveViewers: ls ? ls.viewer_count : 0
        };
      });

      if (onlyLive) {
        setHistory(mergedData.filter(m => m.isLive));
      } else {
        const sorted = mergedData.sort((a, b) => (b.isLive - a.isLive) || a.ChannelName.localeCompare(b.ChannelName));
        setFullStreamerList(sorted);
      }
    } catch (err) { console.error("Sync failed.", err); }
  }, [settings.historySas, settings.accessToken, fetchWithRetry]);

  const updateActiveStatusInAzure = useCallback(async (channelName, isActive) => {
    if (!settings.historySas) return;
    try {
      const checkRes = await fetchWithRetry(settings.historySas);
      const latestEtag = checkRes.headers.get('ETag');
      let latestData = await checkRes.json();

      let found = false;
      latestData = latestData.map(ch => {
        if (ch.ChannelName.toLowerCase() === channelName.toLowerCase()) {
          ch.ActiveViewers = isActive;
          found = true;
        }
        return ch;
      });

      if (!found) return;

      const putRes = await fetch(settings.historySas, {
        method: 'PUT',
        headers: {
          'x-ms-blob-type': 'BlockBlob',
          'Content-Type': 'application/json',
          'If-Match': latestEtag
        },
        body: JSON.stringify(latestData)
      });

      if (putRes.ok) {
        setAzureEtag(putRes.headers.get('ETag'));
        syncCloudData(tab === 'raid-list');
      }
    } catch (err) { console.error("Azure Status Update failed.", err); }
  }, [settings.historySas, fetchWithRetry, syncCloudData, tab]);

  const finalizeRaidTracking = useCallback((raidChannel) => {
    setRaidTrackers(prev => {
      const tracker = prev[raidChannel];
      if (!tracker) return prev;
      const isActuallyActive = tracker.uniqueUsers.size >= (tracker.totalViewers * 0.05);
      updateActiveStatusInAzure(raidChannel, isActuallyActive);
      const { [raidChannel]: removed, ...remaining } = prev;
      return remaining;
    });
  }, [updateActiveStatusInAzure]);

  // --- EFFECTS ---
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const hash = window.location.hash;
    if (hash && hash.includes("access_token")) {
      const params = new URLSearchParams(hash.substring(1));
      const token = params.get('access_token');
      if (token) {
        updateSetting('accessToken', token);
        window.history.replaceState({}, document.title, "/");
      }
    }
    loadLocalShoutouts().then(() => fetchLiveSessionFromCloud());

    fetch('/api/localnotes').then(res => res.json()).then(setLocalNotes).catch(console.error);
  }, [fetchLiveSessionFromCloud, loadLocalShoutouts]);

  useEffect(() => {
    if (!settings.accessToken) return;
    const headers = { 'Client-ID': CLIENT_ID, 'Authorization': `Bearer ${settings.accessToken}` };

    fetch(`https://api.twitch.tv/helix/users`, { headers })
      .then(res => res.json())
      .then(data => data.data?.[0] && setMyUserId(data.data[0].id))
      .catch(console.error);

    if (settings.channel) {
      fetch(`https://api.twitch.tv/helix/users?login=${settings.channel}`, { headers })
        .then(res => res.json())
        .then(data => data.data?.[0] && setBroadcasterId(data.data[0].id))
        .catch(console.error);
    }
  }, [settings.accessToken, settings.channel]);

  // --- EVENTSUB WEBSOCKET ---
  useEffect(() => {
    if (!broadcasterId || !myUserId || !settings.accessToken) return;
    let socket = new WebSocket('wss://eventsub.wss.twitch.tv/ws');

    socket.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      if (data.metadata.message_type === 'session_welcome') {
        fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
          method: 'POST',
          headers: {
            'Client-ID': CLIENT_ID,
            'Authorization': `Bearer ${settings.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type: 'channel.shoutout.create',
            version: '1',
            condition: { broadcaster_user_id: broadcasterId, moderator_user_id: myUserId },
            transport: { method: 'websocket', session_id: data.payload.session.id }
          })
        });
      }
      if (data.metadata.message_type === 'notification') {
        const info = data.payload.event;
        const target = info.to_broadcaster_user_login.toLowerCase();
        setSession(prev => {
          const exists = prev.find(s => s.name.toLowerCase() === target);
          const updated = exists
            ? prev.map(s => s.name.toLowerCase() === target ? { ...s, lastSO: new Date().toISOString() } : s)
            : [{ name: info.to_broadcaster_user_name, time: null, viewers: 0, lastSO: new Date().toISOString() }, ...prev];
          saveShoutoutsToDisk(updated);
          return updated;
        });
      }
    };
    return () => socket.close();
  }, [broadcasterId, myUserId, settings.accessToken]);

  // --- TMI CHAT ---
  useEffect(() => {
    if (!settings.channel || !settings.accessToken) return;
    let isCancelled = false;
    const client = new tmi.Client({
      options: { debug: false, skipUpdatingEmotesets: true, secure: true },
      identity: { username: settings.channel, password: `oauth:${settings.accessToken.replace('oauth:', '')}` },
      channels: [settings.channel]
    });

    client.on('raided', (channel, username, viewers) => {
      const raidChannel = username.toLowerCase();
      setSession(prev => {
        const newSession = [{ name: username, time: new Date().toISOString(), lastSO: null, viewers: viewers }, ...prev];
        saveShoutoutsToDisk(newSession);
        return newSession;
      });
      setRaidTrackers(prev => ({ ...prev, [raidChannel]: { totalViewers: viewers, uniqueUsers: new Set() } }));
      setTimeout(() => finalizeRaidTracking(raidChannel), 15 * 60 * 1000);
    });

    client.on('message', (channel, userstate) => {
      if (userstate.badges?.raider) {
        setRaidTrackers(prev => {
          const trackers = { ...prev };
          for (const source in trackers) {
            if (!trackers[source].uniqueUsers.has(userstate.username)) {
              trackers[source].uniqueUsers.add(userstate.username);
              if (trackers[source].uniqueUsers.size >= (trackers[source].totalViewers * 0.05)) {
                setTimeout(() => finalizeRaidTracking(source), 10);
              }
            }
          }
          return trackers;
        });
      }
    });

    client.connect().catch(err => !isCancelled && console.error("TMI Failed:", err));
    return () => { isCancelled = true; client.disconnect().catch(() => { }); };
  }, [settings.channel, settings.accessToken, finalizeRaidTracking]);

  const saveAzureNote = async (channelName) => {
    try {
      const checkRes = await fetchWithRetry(settings.historySas);
      const latestEtag = checkRes.headers.get('ETag');
      const latestData = (await checkRes.json()).map(ch =>
        ch.ChannelName === channelName ? { ...ch, Notes: editingAzureNote.text } : ch
      );
      const putRes = await fetch(settings.historySas, {
        method: 'PUT',
        headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/json', 'If-Match': latestEtag },
        body: JSON.stringify(latestData)
      });
      if (putRes.ok) {
        setAzureEtag(putRes.headers.get('ETag'));
        const updater = prev => prev.map(h => h.ChannelName === channelName ? { ...h, Notes: editingAzureNote.text } : h);
        setHistory(updater); setFullStreamerList(updater); setEditingAzureNote({ name: null, text: '' });
      }
    } catch (err) { console.error(err); }
  };

  const clearCloudSession = async () => {
    if (!settings.liveSas || !window.confirm("Clear Azure and Local Session?")) return;
    try {
      const res = await fetch(settings.liveSas, {
        method: 'PUT',
        headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/json' },
        body: JSON.stringify([])
      });
      if (res.ok) { await saveShoutoutsToDisk([]); alert("Cleared."); }
    } catch (err) { alert("Failed to clear cloud."); }
  };

  const saveNotesListToDisk = async (updatedList) => {
    try {
      await fetch('/api/localnotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedList)
      });
      setLocalNotes(updatedList);
    } catch (err) { alert("Disk save failed."); }
  };

  const renderDetailedAzureCard = (item) => (
    <div key={item.ChannelName} style={styles.card}>
      <div style={styles.cardSection}>
        <div style={{ fontSize: '18px' }}>
          <strong style={{ color: '#9146FF' }}>{item.ChannelName}</strong>
          {item.isLive && <span> || {item.Category} || {item.Title} || <span style={{ color: '#ff4444' }}>Live: {item.Uptime}</span></span>}
          {!item.isLive && <span style={{ fontSize: '12px', marginLeft: '10px', color: '#555' }}>○ OFFLINE</span>}
        </div>
        <div style={styles.dataRow}>
          <strong>Incoming:</strong> Raided us <b>{item.TotalTimesRaidedUs}</b> times. Last: {item.LastTimeRaidedUs ? new Date(item.LastTimeRaidedUs).toLocaleDateString() : 'N/A'}
        </div>
        <div style={styles.dataRow}>
          <strong>Outgoing:</strong> We raided them <b>{item.TotalTimesWeRaidedThem}</b> times. Last: {item.LastTimeWeRaidedThem ? new Date(item.LastTimeWeRaidedThem).toLocaleDateString() : 'N/A'}
        </div>
        <div style={{ ...styles.dataRow, display: 'flex', gap: '20px', marginTop: '4px', padding: '4px 0', borderTop: '1px solid #26262c' }}>
          <span>📉 Active Viewers: <b style={{ color: item.ActiveViewers ? '#00c851' : '#ff4444' }}>{item.ActiveViewers ? 'Yes' : 'No'}</b></span>
        </div>
        <div style={{ marginTop: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong> Azure Notes:</strong>
            {editingAzureNote.name !== item.ChannelName && (
              <button onClick={() => setEditingAzureNote({ name: item.ChannelName, text: item.Notes || '' })} style={styles.smallBtn}>Edit Note</button>
            )}
          </div>
          {editingAzureNote.name === item.ChannelName ? (
            <div style={{ marginTop: '5px' }}>
              <textarea style={styles.textarea} value={editingAzureNote.text} onChange={(e) => setEditingAzureNote({ ...editingAzureNote, text: e.target.value })} />
              <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                <button onClick={() => saveAzureNote(item.ChannelName)} style={{ ...styles.smallBtn, backgroundColor: '#00c851' }}>Save</button>
                <button onClick={() => setEditingAzureNote({ name: null, text: '' })} style={{ ...styles.smallBtn, backgroundColor: '#ff4444' }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={styles.notes}>{item.Notes || "No notes yet."}</div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div style={styles.container}>
      <nav style={styles.nav}>
        {['raid-list', 'shoutouts', 'notes', 'streamers', 'settings'].map(t => (
          <button key={t} style={tab === t ? styles.activeTab : styles.tab} onClick={() => setTab(t)}>
            {t.replace('-', ' ').toUpperCase()}
          </button>
        ))}
      </nav>

      {tab === 'raid-list' && (
        <div style={styles.pane}>
          <button onClick={() => syncCloudData(true)} style={styles.button}>🔄 Sync & Filter Live Channels</button>
          {history.map(item => renderDetailedAzureCard(item))}
        </div>
      )}

      {tab === 'shoutouts' && (
        <div style={styles.pane}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Active Raids (Local Sync)</span>
            <button onClick={fetchLiveSessionFromCloud} style={{ ...styles.soButton, fontSize: '11px' }}>Force Cloud Pull</button>
          </div>
          {session.filter(s => s.viewers > 0 || s.time !== null).length === 0 && <p style={{ color: '#888', textAlign: 'center' }}>No raids recorded today.</p>}
          {[...session]
            .filter(s => s.viewers > 0 || s.time !== null)
            .sort((a, b) => {
              // 1. Get timestamps for last shoutout (0 if never shouted out)
              const timeA = a.lastSO ? Date.parse(a.lastSO) : 0;
              const timeB = b.lastSO ? Date.parse(b.lastSO) : 0;

              // 2. If one has NEVER been shouted out and the other has, 
              // the one with NO shoutout stays on top.
              if (timeA === 0 && timeB !== 0) return -1;
              if (timeA !== 0 && timeB === 0) return 1;

              // 3. If BOTH have never been shouted out, sort by Raid Time (newest raid on top)
              if (timeA === 0 && timeB === 0) {
                return Date.parse(b.time) - Date.parse(a.time);
              }

              // 4. If BOTH have been shouted out, sort by the lastSO time 
              // (most recent shoutout goes to the very bottom)
              return timeA - timeB;
            })
            .map(s => {
              const diff = Math.floor((currentTime - (s.lastSO ? Date.parse(s.lastSO) : 0)) / 60000);
              const isRed = s.lastSO && diff < 60; // Only red if a shoutout actually exists
              const remaining = Math.max(0, 60 - diff);

              return (
                <div key={s.name} style={{ ...styles.card, borderLeft: `8px solid ${isRed ? '#ff4444' : '#00c851'}` }}>
                  <div style={{ flex: 1 }}>
                    <strong style={{ color: isRed ? '#ff4444' : '#00c851' }}>{s.name}</strong>
                    <div style={{ fontSize: '14px', fontWeight: 'bold', marginTop: '4px' }}>
                      {isRed ? <span style={{ color: '#ff4444' }}>-{remaining}m</span> : <span style={{ color: '#00c851' }}>Ready!</span>}
                    </div>
                  </div>
                  <button onClick={() => copyText(`/shoutout ${s.name}`)} style={styles.soButton}>Copy /SO</button>
                </div>
              );
            })}
        </div>
      )}

      {tab === 'notes' && (
        <div style={styles.pane}>
          {!isCreatingNewNote ? (
            <button onClick={() => { setIsCreatingNewNote(true); setTimeout(() => newNoteRef.current?.focus(), 10); }} style={styles.button}>➕ New Note</button>
          ) : (
            <div style={{ ...styles.card, flexDirection: 'column', gap: '10px' }}>
              <textarea ref={newNoteRef} style={styles.localNotesTextarea} value={newNoteText} onChange={e => setNewNoteText(e.target.value)} placeholder="Type note..." />
              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={() => { saveNotesListToDisk([{ id: Date.now(), text: newNoteText, timestamp: new Date().toLocaleString() }, ...localNotes]); setIsCreatingNewNote(false); setNewNoteText(''); }} style={{ ...styles.smallBtn, backgroundColor: '#00c851' }}>Save</button>
                <button onClick={() => setIsCreatingNewNote(false)} style={{ ...styles.smallBtn, backgroundColor: '#ff4444' }}>Cancel</button>
              </div>
            </div>
          )}
          {localNotes.map(note => (
            <div key={note.id} style={styles.localNoteCard}>
              <button onClick={() => copyText(note.text)} style={styles.copyBtn}>📋</button>
              <div style={{ flex: 1 }}>
                {editingLocalNoteId === note.id ? (
                  <textarea style={styles.localNotesTextarea} value={editText} onChange={e => setEditText(e.target.value)} />
                ) : (
                  <div style={styles.notes}>{note.text}</div>
                )}
              </div>
              <div style={styles.noteActions}>
                {editingLocalNoteId === note.id ? (
                  <button onClick={() => { saveNotesListToDisk(localNotes.map(n => n.id === note.id ? { ...n, text: editText } : n)); setEditingLocalNoteId(null); }} style={{ ...styles.smallBtn, backgroundColor: '#00c851' }}>Save</button>
                ) : (
                  <button onClick={() => { setEditingLocalNoteId(note.id); setEditText(note.text); }} style={styles.smallBtn}>Edit</button>
                )}
                <button onClick={() => { if (window.confirm("Delete?")) saveNotesListToDisk(localNotes.filter(n => n.id !== note.id)) }} style={{ ...styles.smallBtn, backgroundColor: '#aa0000' }}>Del</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'streamers' && (
        <div style={styles.pane}>
          <button onClick={() => syncCloudData(false)} style={styles.button}>🔄 Load Full Streamer Database</button>
          {fullStreamerList.map(item => renderDetailedAzureCard(item))}
        </div>
      )}

      {tab === 'settings' && (
        <div style={styles.pane}>
          <button onClick={loginWithTwitch} style={{ ...styles.button, backgroundColor: settings.accessToken ? '#00c851' : '#9146FF' }}>
            {settings.accessToken ? "✅ Twitch Connected" : "Connect Twitch Account"}
          </button>
          <div style={styles.formGroup}>
            <label>Twitch Channel (Target to Track)</label>
            <input value={settings.channel} onChange={e => updateSetting('channel', e.target.value.toLowerCase())} />
            <label>History SAS URL (Cloud)</label>
            <input value={settings.historySas} onChange={e => updateSetting('historySas', e.target.value)} />
            <label>Live Tracker SAS URL (Cloud)</label>
            <input value={settings.liveSas} onChange={e => updateSetting('liveSas', e.target.value)} />
          </div>
          <button onClick={clearCloudSession} style={{ ...styles.button, backgroundColor: '#ff4444', marginTop: '20px' }}>🗑️ Clear Azure Session</button>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: { padding: '20px', backgroundColor: '#0e0e10', color: '#efeff1', minHeight: '100vh', fontFamily: 'Inter, sans-serif' },
  nav: { display: 'flex', gap: '15px', marginBottom: '20px', borderBottom: '1px solid #26262c', paddingBottom: '10px' },
  tab: { background: 'none', border: 'none', color: '#adadb8', cursor: 'pointer', fontSize: '16px', padding: '5px 10px' },
  activeTab: { background: 'none', border: 'none', color: '#bf94ff', cursor: 'pointer', fontSize: '16px', fontWeight: '700', borderBottom: '2px solid #bf94ff', padding: '5px 10px' },
  pane: { display: 'flex', flexDirection: 'column', gap: '12px' },
  card: { backgroundColor: '#18181b', padding: '16px', borderRadius: '4px', border: '1px solid #26262c', display: 'flex', alignItems: 'center' },
  cardSection: { display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' },
  dataRow: { fontSize: '14px', color: '#adadb8' },
  notes: { fontSize: '14px', backgroundColor: '#0a0a0b', padding: '12px', borderRadius: '4px', marginTop: '4px', color: '#dedee3', whiteSpace: 'pre-wrap' },
  button: { padding: '10px', cursor: 'pointer', border: 'none', borderRadius: '4px', color: 'white', fontWeight: 'bold', backgroundColor: '#9146FF' },
  soButton: { backgroundColor: '#35353b', color: '#fff', border: 'none', padding: '8px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' },
  smallBtn: { padding: '6px 10px', fontSize: '12px', color: '#fff', border: 'none', borderRadius: '3px', cursor: 'pointer', backgroundColor: '#35353b', fontWeight: 'bold' },
  textarea: { width: '100%', backgroundColor: '#000', color: '#fff', border: '1px solid #9146FF', borderRadius: '4px', padding: '10px', minHeight: '60px', marginTop: '5px', boxSizing: 'border-box' },
  formGroup: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '20px' },
  localNoteCard: { backgroundColor: '#141416', padding: '12px', borderRadius: '4px', border: '1px solid #26262c', display: 'flex', alignItems: 'flex-start', gap: '12px' },
  noteActions: { display: 'flex', flexDirection: 'column', gap: '5px' },
  copyBtn: { fontSize: '18px', background: 'none', border: 'none', cursor: 'pointer', padding: '0 5px', color: '#adadb8' },
  localNotesTextarea: { width: '100%', backgroundColor: '#000', color: '#fff', border: '1px solid #bf94ff', borderRadius: '4px', padding: '10px', minHeight: '120px', boxSizing: 'border-box' }
};

export default App;