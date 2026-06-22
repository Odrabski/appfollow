import { useState, useEffect, useRef } from 'react';
import { VERSION } from './version.js';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// ─── API helpers ─────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, { credentials: 'include', ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  }
  return res.json();
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20H24v8h11.3C33.6 33.1 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.1 6.5 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.7-8 19.7-20 0-1.3-.1-2.7-.1-4z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.5 15.1 18.9 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.1 6.5 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-1.9 13.5-5l-6.2-5.2C29.4 35.5 26.8 36 24 36c-5.2 0-9.5-2.9-11.3-7l-6.5 5C9.7 39.7 16.3 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20H24v8h11.3c-.8 2.2-2.3 4-4.2 5.3l6.2 5.2C40.9 35.2 44 30 44 24c0-1.3-.1-2.7-.4-4z"/>
    </svg>
  );
}

const COUNTRIES = [
  { code: 'il', label: 'Israel', flag: '🇮🇱' },
  { code: 'us', label: 'United States', flag: '🇺🇸' },
  { code: 'gb', label: 'United Kingdom', flag: '🇬🇧' },
  { code: 'de', label: 'Germany', flag: '🇩🇪' },
  { code: 'fr', label: 'France', flag: '🇫🇷' },
  { code: 'au', label: 'Australia', flag: '🇦🇺' },
];

function countryFlag(code) {
  return COUNTRIES.find(c => c.code === code)?.flag ?? code.toUpperCase();
}

function PlatformBadge({ platform }) {
  return platform === 'android' ? (
    <span className="text-xs font-medium bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
      Google Play
    </span>
  ) : (
    <span className="text-xs font-medium bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
      App Store
    </span>
  );
}

function StarRating({ rating }) {
  if (!rating) return <span className="text-slate-400 text-sm">No rating</span>;
  return (
    <span className="text-sm text-amber-500 font-medium">
      ★ {rating.toFixed(1)}
    </span>
  );
}

function Toast({ message, type, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const colours = {
    success: 'bg-emerald-600',
    error: 'bg-red-600',
    info: 'bg-indigo-600',
  };

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 ${colours[type] ?? colours.info} text-white text-sm font-medium px-4 py-3 rounded-xl shadow-lg max-w-sm animate-fade-in`}
    >
      <span className="flex-1">{message}</span>
      <button onClick={onDismiss} className="opacity-70 hover:opacity-100 text-lg leading-none">×</button>
    </div>
  );
}

function UrlModal({ watchlistIds, onAdd, onClose, country = 'il' }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState([]);
  const [processing, setProcessing] = useState(false);
  const debounceRef = useRef(null);

  const urls = text.split('\n').map(s => s.trim()).filter(Boolean);
  const isSingle = urls.length === 1;

  // Auto-lookup for single URL
  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!isSingle || !urls[0].startsWith('http')) {
      if (isSingle) setResults([]);
      return;
    }
    const url = urls[0];
    debounceRef.current = setTimeout(async () => {
      setResults([{ url, status: 'loading' }]);
      try {
        const app = await apiFetch('/api/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, country }),
        });
        setResults([{ url, status: 'success', app }]);
      } catch (err) {
        setResults([{ url, status: 'error', error: err.message || 'Could not find app at that URL' }]);
      }
    }, 400);
    return () => clearTimeout(debounceRef.current);
  }, [text]);

  // Clear results when switching from single → multi
  useEffect(() => {
    if (urls.length > 1) setResults([]);
  }, [urls.length]);

  async function lookupAll() {
    setProcessing(true);
    const initial = urls.map(url => ({ url, status: 'loading' }));
    setResults(initial);
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const app = await apiFetch('/api/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        setResults(prev => prev.map((r, idx) => idx === i ? { url, status: 'success', app } : r));
      } catch (err) {
        setResults(prev => prev.map((r, idx) => idx === i ? { url, status: 'error', error: err.message || 'Not found' } : r));
      }
    }
    setProcessing(false);
  }

  const successResults = results.filter(r => r.status === 'success');
  const addableResults = successResults.filter(r => !watchlistIds.has(r.app.id));

  async function addAll() {
    for (const r of addableResults) {
      await onAdd(r.app);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[85vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 flex-shrink-0">
          <h3 className="font-bold text-slate-900">Add Apps by URL</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <textarea
            autoFocus
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={"Paste one or more store URLs (one per line)…\nhttps://apps.apple.com/…\nhttps://play.google.com/…"}
            rows={4}
            className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white resize-none"
          />

          {/* Bulk lookup button */}
          {urls.length > 1 && results.length === 0 && (
            <button
              onClick={lookupAll}
              disabled={processing}
              className="w-full text-sm bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white py-2.5 rounded-xl font-medium transition-colors"
            >
              Look up {urls.length} apps
            </button>
          )}

          {/* Results */}
          {results.length > 0 && (
            <div className="space-y-3">
              {results.map((r, i) => {
                if (r.status === 'loading') {
                  return (
                    <div key={i} className="flex items-center gap-3 bg-slate-50 rounded-xl px-4 py-3">
                      <svg className="w-4 h-4 text-indigo-500 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                      </svg>
                      <span className="text-sm text-slate-500 truncate">{r.url}</span>
                    </div>
                  );
                }
                if (r.status === 'error') {
                  return (
                    <div key={i} className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                      <span className="text-red-500 text-lg leading-none flex-shrink-0">✕</span>
                      <span className="text-sm text-red-600 truncate">{r.error}</span>
                    </div>
                  );
                }
                // success
                const alreadyWatching = watchlistIds.has(r.app.id);
                return (
                  <div key={i} className="bg-slate-50 rounded-xl px-4 py-3">
                    <AppCard
                      app={r.app}
                      inWatchlist={alreadyWatching}
                      onAdd={onAdd}
                      onRemove={() => {}}
                      compact
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer — bulk Add All */}
        {urls.length > 1 && addableResults.length > 0 && !processing && (
          <div className="px-5 py-3 border-t border-slate-200 flex-shrink-0">
            <button
              onClick={addAll}
              className="w-full text-sm bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl font-medium transition-colors"
            >
              Add all {addableResults.length} app{addableResults.length !== 1 ? 's' : ''} to watchlist
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewModal({ apps, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 flex-shrink-0">
          <h3 className="font-bold text-slate-900">Report Preview</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>
        <div className="overflow-y-auto flex-1 divide-y divide-slate-100">
          {apps.map(a => (
            <div key={a.id} className="px-5 py-4">
              <div className="flex items-center gap-3 mb-2">
                {a.icon
                  ? <img src={a.icon} alt="" referrerPolicy="no-referrer" className="w-10 h-10 rounded-xl flex-shrink-0 object-cover" />
                  : <div className="w-10 h-10 rounded-xl bg-slate-100 flex-shrink-0" />
                }
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900 truncate">{a.title}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-xs text-slate-500 truncate">{a.developer}</p>
                    <PlatformBadge platform={a.platform} />
                  </div>
                </div>
              </div>
              {a.fetchError ? (
                <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">Could not retrieve data.</p>
              ) : (
                <>
                  {a.staleWarning && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 mb-2">
                      Cached data from {new Date(a.cachedAt).toLocaleString()} — live fetch failed
                    </p>
                  )}
                  <div className="text-sm text-slate-600 space-y-1 mb-2">
                    <p><span className="font-medium text-slate-700 w-20 inline-block">Version</span>{a.version || 'N/A'}</p>
                    <p><span className="font-medium text-slate-700 w-20 inline-block">Updated</span>{a.updatedDate || 'N/A'}</p>
                    <p><span className="font-medium text-slate-700 w-20 inline-block">Rating</span>{a.rating != null ? `${a.rating} / 5.0` : 'N/A'}</p>
                  </div>
                  {a.whatsNew && (
                    <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3 max-h-28 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                      {a.whatsNew}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-slate-200 flex-shrink-0 text-right">
          <button
            onClick={onClose}
            className="text-sm text-slate-600 hover:text-slate-900 border border-slate-200 px-4 py-2 rounded-xl"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function AppCard({ app, inWatchlist, onAdd, onRemove, compact = false, details = null, showCountry = false }) {
  return (
    <div className={`flex items-start gap-3 ${compact ? 'py-3' : 'bg-white border border-slate-200 rounded-xl p-4 hover:shadow-md transition-shadow'}`}>
      {app.icon
        ? <img src={app.icon} alt="" referrerPolicy="no-referrer" className="w-12 h-12 rounded-xl flex-shrink-0 object-cover" />
        : <div className="w-12 h-12 rounded-xl flex-shrink-0 bg-slate-100 flex items-center justify-center text-2xl">📦</div>
      }
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {app.storeUrl ? (
              <a
                href={app.storeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-slate-900 hover:text-indigo-600 truncate block transition-colors"
              >
                {app.title}
              </a>
            ) : (
              <p className="font-semibold text-slate-900 truncate">{app.title}</p>
            )}
            <p className="text-xs text-slate-500 truncate">{app.developer}</p>
          </div>
          <div className="flex-shrink-0">
            {inWatchlist ? (
              <button
                onClick={() => onRemove(app)}
                className="text-xs bg-red-50 hover:bg-red-100 text-red-600 px-3 py-1.5 rounded-lg font-medium transition-colors"
              >
                Remove
              </button>
            ) : (
              <button
                onClick={() => onAdd(app)}
                className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg font-medium transition-colors"
              >
                + Watch
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <PlatformBadge platform={app.platform} />
          {showCountry && app.country && (
            <span className="text-xs text-slate-400" title={COUNTRIES.find(c => c.code === app.country)?.label}>
              {countryFlag(app.country)}
            </span>
          )}
          <StarRating rating={app.rating} />
          {app.storeUrl && (
            <a
              href={app.storeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-indigo-500 hover:text-indigo-700 transition-colors"
            >
              View in store ↗
            </a>
          )}
        </div>
        {details?.updatedDate && (
          <p className="text-xs text-slate-400 mt-0.5">Updated {details.updatedDate}</p>
        )}
      </div>
    </div>
  );
}

function SortableWatchlistItem({ app, onRemove, details }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: app.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`px-4 flex items-center gap-2 ${isDragging ? 'opacity-50 bg-indigo-50 rounded-xl' : ''}`}
    >
      <button
        {...attributes}
        {...listeners}
        className="text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing flex-shrink-0 py-3 touch-none"
        tabIndex={-1}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
        </svg>
      </button>
      <div className="flex-1 min-w-0">
        <AppCard app={app} inWatchlist={true} onAdd={() => {}} onRemove={onRemove} compact details={details} />
      </div>
    </div>
  );
}

// ─── Login Screen ─────────────────────────────────────────────────────────────

function LoginScreen({ urlError }) {
  const errorMessages = {
    unauthorized: 'Access is restricted to authorized accounts only.',
    auth_failed: 'Authentication failed. Please try again.',
    access_denied: 'You cancelled the login. Please try again.',
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-100 p-10 max-w-sm w-full text-center">
        <div className="text-5xl mb-5">🚀</div>
        <h1 className="text-2xl font-bold text-slate-900 mb-2">Competitor Intelligence</h1>
        <p className="text-slate-500 text-sm mb-8">
          Track competitor app updates and get a morning briefing straight to your inbox.
        </p>

        {urlError && (
          <div className="mb-5 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
            {errorMessages[urlError] ?? 'Something went wrong.'}
          </div>
        )}

        <a
          href="/auth/google"
          className="flex items-center justify-center gap-3 w-full border-2 border-slate-200 hover:border-slate-300 hover:bg-slate-50 rounded-xl px-5 py-3 text-slate-700 font-medium transition-all"
        >
          <GoogleIcon />
          Sign in with Google
        </a>
        <p className="text-xs text-slate-400 mt-5">Access restricted to drabski@gmail.com</p>
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

function Dashboard({ user, onLogout }) {
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('all');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [watchlist, setWatchlist] = useState([]);
  const [toast, setToast] = useState(null);
  const [urlModalOpen, setUrlModalOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [listName, setListName] = useState('Competitor Watchlist');
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [sortMode, setSortMode] = useState('manual'); // 'manual' | 'name' | 'store' | 'recent'
  const [detailsMap, setDetailsMap] = useState({});
  const [allLists, setAllLists] = useState([]);
  const [activeListId, setActiveListId] = useState(null);
  const [addingList, setAddingList] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [hideWatched, setHideWatched] = useState(false);
  const [country, setCountry] = useState('il');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [renamingListId, setRenamingListId] = useState(null);
  const [renameInput, setRenameInput] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [sendingActive, setSendingActive] = useState(false);
  const [sendingAll, setSendingAll] = useState(false);
  const debounceRef = useRef(null);
  const dropdownRef = useRef(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Load watchlists and active list data on mount
  useEffect(() => {
    Promise.all([
      apiFetch('/api/watchlists'),
      apiFetch('/api/watchlist'),
      apiFetch('/api/watchlist/details'),
      apiFetch('/api/watchlist/meta'),
    ]).then(([listsResp, list, details, meta]) => {
      setAllLists(listsResp.lists);
      setActiveListId(listsResp.activeId);
      setWatchlist(list);
      setDetailsMap(details);
      setListName(meta.name);
    }).catch(() => {});
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    function onOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
        setConfirmDeleteId(null);
        setRenamingListId(null);
      }
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [dropdownOpen]);

  // Re-apply recent sort whenever detailsMap updates
  useEffect(() => {
    if (sortMode !== 'recent') return;
    setWatchlist(prev => [...prev].sort(
      (a, b) => (detailsMap[b.id]?.updatedTimestamp || 0) - (detailsMap[a.id]?.updatedTimestamp || 0)
    ));
  }, [detailsMap, sortMode]);

  async function saveListName(name) {
    try {
      const d = await apiFetch('/api/watchlist/meta', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      setListName(d.name);
    } catch {
      showToast('Failed to save list name', 'error');
    }
  }

  function startEditingName() {
    setNameInput(listName);
    setEditingName(true);
  }

  function commitNameEdit() {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== listName) saveListName(trimmed);
    setEditingName(false);
  }

  async function switchList(id) {
    try {
      const { activeId, lists } = await apiFetch('/api/watchlists/active', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setAllLists(lists);
      setActiveListId(activeId);
      const [apps, details, meta] = await Promise.all([
        apiFetch('/api/watchlist'),
        apiFetch('/api/watchlist/details'),
        apiFetch('/api/watchlist/meta'),
      ]);
      setWatchlist(apps);
      setDetailsMap(details);
      setListName(meta.name);
      setSortMode('manual');
    } catch (err) {
      showToast(err.message || 'Failed to switch list', 'error');
    }
  }

  async function createList(name) {
    try {
      const { activeId, lists } = await apiFetch('/api/watchlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      setAllLists(lists);
      setActiveListId(activeId);
      setWatchlist([]);
      setDetailsMap({});
      setListName(name);
      setSortMode('manual');
      setAddingList(false);
      setNewListName('');
    } catch (err) {
      showToast(err.message || 'Failed to create list', 'error');
    }
  }

  async function toggleDailyReport(id) {
    try {
      const { activeId, lists } = await apiFetch(`/api/watchlists/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toggleDailyReport: true }),
      });
      setAllLists(lists);
      setActiveListId(activeId);
    } catch (err) {
      showToast(err.message || 'Failed to update', 'error');
    }
  }

  async function commitRenameList(id) {
    const trimmed = renameInput.trim();
    setRenamingListId(null);
    if (!trimmed) return;
    try {
      const { activeId, lists } = await apiFetch(`/api/watchlists/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      setAllLists(lists);
      setActiveListId(activeId);
      if (id === activeListId) setListName(trimmed);
    } catch (err) {
      showToast(err.message || 'Failed to rename', 'error');
    }
  }

  async function sendThisList() {
    setSendingActive(true);
    try {
      await apiFetch('/api/report/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listId: activeListId, sortedIds: watchlist.map(w => w.id) }),
      });
      showToast(`Report sent for "${listName}".`, 'success');
    } catch (err) {
      if (err.status === 401) showToast('Session expired — please sign out and sign back in.', 'error');
      else showToast(err.message || 'Failed to send report', 'error');
    } finally {
      setSendingActive(false);
    }
  }

  async function sendAllEnabled() {
    setSendingAll(true);
    try {
      const { listsSent, appsReported } = await apiFetch('/api/report/send', { method: 'POST' });
      showToast(`Sent ${listsSent} report${listsSent !== 1 ? 's' : ''} covering ${appsReported} app${appsReported !== 1 ? 's' : ''}.`, 'success');
    } catch (err) {
      if (err.status === 401) showToast('Session expired — please sign out and sign back in.', 'error');
      else showToast(err.message || 'Failed to send reports', 'error');
    } finally {
      setSendingAll(false);
    }
  }

  async function deleteList(id) {
    try {
      const wasActive = id === activeListId;
      const { activeId, lists } = await apiFetch(`/api/watchlists/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      setAllLists(lists);
      setActiveListId(activeId);
      if (wasActive) {
        const [apps, details, meta] = await Promise.all([
          apiFetch('/api/watchlist'),
          apiFetch('/api/watchlist/details'),
          apiFetch('/api/watchlist/meta'),
        ]);
        setWatchlist(apps);
        setDetailsMap(details);
        setListName(meta.name);
        setSortMode('manual');
      }
    } catch (err) {
      showToast(err.message || 'Failed to delete list', 'error');
    }
  }

  async function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = watchlist.findIndex(w => w.id === active.id);
    const newIndex = watchlist.findIndex(w => w.id === over.id);
    const reordered = arrayMove(watchlist, oldIndex, newIndex);
    setWatchlist(reordered);
    setSortMode('manual');
    try {
      await apiFetch('/api/watchlist/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: reordered.map(w => w.id) }),
      });
    } catch {
      showToast('Failed to save order', 'error');
    }
  }

  function applySortMode(mode) {
    setSortMode(mode);
    if (mode === 'manual') return;
    if (mode === 'recent') return; // handled by the detailsMap effect
    const sorted = [...watchlist].sort((a, b) => {
      if (mode === 'name') return (a.title || '').localeCompare(b.title || '');
      if (mode === 'store') return a.platform.localeCompare(b.platform);
      return 0;
    });
    setWatchlist(sorted);
    apiFetch('/api/watchlist/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: sorted.map(w => w.id) }),
    }).catch(() => showToast('Failed to save order', 'error'));
  }

  function showToast(message, type = 'success') {
    setToast({ message, type, key: Date.now() });
  }

  function handleLogout() {
    apiFetch('/auth/logout', { method: 'POST' })
      .finally(onLogout);
  }

  // Debounced search
  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ q: query.trim() });
        if (platform !== 'all') params.set('platform', platform);
        params.set('country', country);
        const data = await apiFetch(`/api/search?${params}`);
        setResults(data);
      } catch (err) {
        showToast(err.message || 'Search failed', 'error');
      } finally {
        setSearching(false);
      }
    }, 500);
    return () => clearTimeout(debounceRef.current);
  }, [query, platform, country]);

  async function addToWatchlist(app) {
    try {
      const { watchlist: updated } = await apiFetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(app),
      });
      setWatchlist(updated);
      showToast(`"${app.title}" added to watchlist`);
    } catch (err) {
      if (err.status === 409) {
        showToast('Already in your watchlist', 'info');
      } else {
        showToast(err.message || 'Failed to add app', 'error');
      }
    }
  }

  async function removeFromWatchlist(app) {
    try {
      const { watchlist: updated } = await apiFetch(
        `/api/watchlist/${encodeURIComponent(app.id)}`,
        { method: 'DELETE' }
      );
      setWatchlist(updated);
      showToast(`"${app.title}" removed`);
    } catch (err) {
      showToast(err.message || 'Failed to remove app', 'error');
    }
  }

  async function previewReport() {
    setPreviewing(true);
    try {
      const data = await apiFetch('/api/report/preview');
      setPreviewData(data);
    } catch (err) {
      if (err.status === 401) {
        showToast('Session expired — please sign out and sign back in.', 'error');
      } else {
        showToast(err.message || 'Failed to load preview', 'error');
      }
    } finally {
      setPreviewing(false);
    }
  }

  const watchlistIds = new Set(watchlist.map(w => w.id));
  const visibleResults = hideWatched ? results.filter(r => !watchlistIds.has(r.id)) : results;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5 font-bold text-slate-900">
            <span className="text-xl">🚀</span>
            <span>AppFollow</span>
            <span className="hidden sm:inline text-slate-400 font-normal text-sm">/ Competitor Intelligence</span>
            <span className="text-xs font-medium text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-md">v{VERSION}</span>
          </div>
          <div className="flex items-center gap-3">
            {user.picture && (
              <img src={user.picture} alt="" className="w-7 h-7 rounded-full" />
            )}
            <span className="text-sm text-slate-600 hidden sm:block">{user.email}</span>
            {allLists.some(l => l.dailyReport) && (
              <button
                onClick={sendAllEnabled}
                disabled={sendingAll}
                className="flex items-center gap-1.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white px-3 py-1.5 rounded-lg transition-colors"
              >
                {sendingAll ? (
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                )}
                {sendingAll ? 'Sending…' : `Send all (${allLists.filter(l => l.dailyReport).length})`}
              </button>
            )}
            <button
              onClick={handleLogout}
              className="text-sm text-slate-500 hover:text-slate-800 border border-slate-200 hover:border-slate-300 px-3 py-1.5 rounded-lg transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-8 grid grid-cols-1 lg:grid-cols-2 gap-8">

        {/* ── Left: Search ── */}
        <section>
          <h2 className="text-lg font-bold text-slate-900 mb-4">App Discovery</h2>

          {/* Add by URL button */}
          <button
            onClick={() => setUrlModalOpen(true)}
            className="w-full mb-4 flex items-center justify-center gap-2 text-sm border-2 border-dashed border-slate-300 hover:border-indigo-400 hover:bg-indigo-50 text-slate-500 hover:text-indigo-600 py-2.5 rounded-xl font-medium transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            Add by URL
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">or</span>
            <div className="flex-1 h-px bg-slate-200" />
          </div>

          {/* Search input */}
          <div className="relative mb-3">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search apps…"
              className="w-full pl-9 pr-4 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
            />
            {searching && (
              <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-indigo-500 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
            )}
          </div>

          {/* Platform tabs */}
          <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-1 mb-3">
            {[['all', 'Both'], ['android', 'Google Play'], ['ios', 'App Store']].map(([val, label]) => (
              <button
                key={val}
                onClick={() => setPlatform(val)}
                className={`flex-1 text-sm py-1.5 rounded-lg font-medium transition-colors ${
                  platform === val
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Market selector */}
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs text-slate-400 flex-shrink-0">Market:</span>
            <select
              value={country}
              onChange={e => setCountry(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 text-slate-700"
            >
              {COUNTRIES.map(c => (
                <option key={c.code} value={c.code}>{c.flag} {c.label}</option>
              ))}
            </select>
          </div>

          {/* Results header with hide-watched toggle */}
          {results.length > 0 && (
            <div className="flex items-center justify-end mb-2">
              <button
                onClick={() => setHideWatched(v => !v)}
                className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg transition-colors ${
                  hideWatched
                    ? 'bg-indigo-100 text-indigo-700'
                    : 'bg-slate-100 text-slate-500 hover:text-slate-700'
                }`}
              >
                <span className={`w-3 h-3 rounded-sm border flex items-center justify-center flex-shrink-0 transition-colors ${
                  hideWatched ? 'bg-indigo-600 border-indigo-600' : 'border-slate-400'
                }`}>
                  {hideWatched && (
                    <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                Hide watched
              </button>
            </div>
          )}

          {/* Results */}
          <div className="space-y-3">
            {visibleResults.length === 0 && query.trim().length >= 2 && !searching && (
              <div className="text-center text-slate-400 text-sm py-10 bg-white rounded-xl border border-slate-200">
                {hideWatched && results.length > 0
                  ? 'All results are already in your watchlist'
                  : `No results found for "${query}"`}
              </div>
            )}
            {results.length === 0 && query.trim().length < 2 && (
              <div className="text-center text-slate-400 text-sm py-10 bg-white rounded-xl border border-slate-200">
                Type at least 2 characters to search
              </div>
            )}
            {visibleResults.map(app => (
              <AppCard
                key={app.id}
                app={app}
                inWatchlist={watchlistIds.has(app.id)}
                onAdd={addToWatchlist}
                onRemove={removeFromWatchlist}
                showCountry
              />
            ))}
          </div>
        </section>

        {/* ── Right: Watchlist ── */}
        <section>
          {/* List dropdown */}
          {allLists.length > 0 && (
            <div className="relative mb-3" ref={dropdownRef}>
              <button
                onClick={() => { setDropdownOpen(v => !v); setConfirmDeleteId(null); setRenamingListId(null); }}
                className="w-full flex items-center gap-2 bg-white border border-slate-200 hover:border-indigo-300 rounded-xl px-4 py-2.5 transition-colors"
              >
                <span className="flex-1 text-left text-sm font-semibold text-slate-900 truncate">{listName}</span>
                {allLists.find(l => l.id === activeListId)?.dailyReport && (
                  <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" title="Daily email enabled" />
                )}
                <span className="text-xs font-medium bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full flex-shrink-0">{watchlist.length}</span>
                <svg className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {dropdownOpen && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-30 overflow-hidden">
                  {allLists.map(list => (
                    <div key={list.id} className={`flex items-center gap-2 px-4 py-3 ${list.id === activeListId ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
                      {renamingListId === list.id ? (
                        <input
                          autoFocus
                          value={renameInput}
                          onChange={e => setRenameInput(e.target.value)}
                          onBlur={() => commitRenameList(list.id)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') commitRenameList(list.id);
                            if (e.key === 'Escape') { setRenamingListId(null); setRenameInput(''); }
                          }}
                          onClick={e => e.stopPropagation()}
                          className="flex-1 text-sm font-medium border-b border-indigo-400 outline-none bg-transparent py-0.5"
                        />
                      ) : (
                        <button
                          className={`flex-1 text-left text-sm font-medium truncate ${list.id === activeListId ? 'text-indigo-700' : 'text-slate-900'}`}
                          onClick={() => { switchList(list.id); setDropdownOpen(false); }}
                        >
                          {list.name}
                        </button>
                      )}
                      <span className="text-xs text-slate-400 flex-shrink-0">{list.id === activeListId ? watchlist.length : list.count}</span>
                      {list.dailyReport && (
                        <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" title="Daily email on" />
                      )}
                      <button
                        onClick={e => { e.stopPropagation(); setRenamingListId(list.id); setRenameInput(list.name); setConfirmDeleteId(null); }}
                        title="Rename"
                        className="text-slate-300 hover:text-slate-600 flex-shrink-0 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                      {allLists.length > 1 && (
                        confirmDeleteId === list.id ? (
                          <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                            <span className="text-xs text-red-600 font-medium">Sure?</span>
                            <button onClick={() => { deleteList(list.id); setConfirmDeleteId(null); setDropdownOpen(false); }} className="text-xs bg-red-600 text-white px-1.5 py-0.5 rounded font-medium hover:bg-red-700">Yes</button>
                            <button onClick={() => setConfirmDeleteId(null)} className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-medium hover:bg-slate-200">No</button>
                          </div>
                        ) : (
                          <button
                            onClick={e => { e.stopPropagation(); setConfirmDeleteId(list.id); setRenamingListId(null); }}
                            title="Delete list"
                            className="text-slate-300 hover:text-red-500 flex-shrink-0 transition-colors"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )
                      )}
                    </div>
                  ))}
                  <div className="border-t border-slate-100 px-4 py-2.5">
                    {addingList ? (
                      <form onSubmit={e => { e.preventDefault(); if (newListName.trim()) createList(newListName.trim()); }} className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={newListName}
                          onChange={e => setNewListName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Escape') { setAddingList(false); setNewListName(''); } }}
                          placeholder="List name…"
                          className="flex-1 text-sm border border-indigo-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                        />
                        <button type="submit" disabled={!newListName.trim()} className="text-sm bg-indigo-600 text-white px-3 py-1.5 rounded-lg font-medium disabled:opacity-40 hover:bg-indigo-700">Add</button>
                        <button type="button" onClick={() => { setAddingList(false); setNewListName(''); }} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
                      </form>
                    ) : (
                      <button onClick={() => setAddingList(true)} className="text-sm text-indigo-600 hover:text-indigo-700 font-medium">+ New list</button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Daily email toggle */}
          <div className="flex items-center justify-between bg-white border border-slate-200 rounded-xl px-4 py-3 mb-3">
            <div>
              <p className="text-sm font-medium text-slate-900">Daily email</p>
              <p className="text-xs text-slate-400 mt-0.5">Sent every morning at 7 AM UTC</p>
            </div>
            <button
              onClick={() => activeListId && toggleDailyReport(activeListId)}
              className={`relative inline-flex w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
                allLists.find(l => l.id === activeListId)?.dailyReport ? 'bg-emerald-500' : 'bg-slate-200'
              }`}
            >
              <span className={`inline-block w-5 h-5 bg-white rounded-full shadow-sm transform transition-transform mt-0.5 ${
                allLists.find(l => l.id === activeListId)?.dailyReport ? 'translate-x-5 ml-0.5' : 'translate-x-0.5'
              }`} />
            </button>
          </div>

          {/* List header: name + Preview + Send this */}
          <div className="flex items-center justify-between mb-3 gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-base font-bold text-slate-900 truncate">{listName}</h2>
              {watchlist.length > 0 && (
                <span className="text-sm font-medium bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full flex-shrink-0">
                  {watchlist.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={previewReport}
                disabled={previewing || watchlist.length === 0}
                className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed text-slate-700 text-sm font-semibold px-3 py-2 rounded-xl transition-colors"
              >
                {previewing ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                ) : 'Preview'}
              </button>
              <button
                onClick={sendThisList}
                disabled={sendingActive || watchlist.length === 0}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white text-sm font-semibold px-3 py-2 rounded-xl transition-colors"
              >
                {sendingActive ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                )}
                {sendingActive ? 'Sending…' : 'Send this'}
              </button>
            </div>
          </div>

          {/* Sort controls */}
          {watchlist.length > 1 && (
            <div className="flex items-center gap-1.5 mb-3">
              <span className="text-xs text-slate-400 mr-1">Sort:</span>
              {[['manual', 'Custom'], ['name', 'Name'], ['store', 'Store'], ['recent', 'Recent']].map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => applySortMode(mode)}
                  className={`text-xs px-2.5 py-1 rounded-lg font-medium transition-colors ${
                    sortMode === mode
                      ? 'bg-indigo-100 text-indigo-700'
                      : 'bg-slate-100 text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
            {watchlist.length === 0 ? (
              <div className="text-center text-slate-400 text-sm py-14 px-6">
                <div className="text-3xl mb-3">📋</div>
                <p className="font-medium text-slate-500 mb-1">Your watchlist is empty</p>
                <p>Search for apps and click <strong>+ Watch</strong> to track them.</p>
              </div>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={watchlist.map(w => w.id)} strategy={verticalListSortingStrategy}>
                  {watchlist.map(app => (
                    <SortableWatchlistItem
                      key={app.id}
                      app={app}
                      onRemove={removeFromWatchlist}
                      details={detailsMap[app.id] ?? null}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </div>

          {watchlist.length > 0 && (
            <p className="text-xs text-slate-400 mt-3 text-center">
              Report will be sent to drabski@gmail.com
            </p>
          )}
        </section>
      </main>

      {/* Toast */}
      {toast && (
        <Toast
          key={toast.key}
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}

      {/* URL modal */}
      {urlModalOpen && (
        <UrlModal
          watchlistIds={watchlistIds}
          onAdd={addToWatchlist}
          onClose={() => setUrlModalOpen(false)}
          country={country}
        />
      )}

      {/* Preview modal */}
      {previewData && (
        <PreviewModal
          apps={previewData}
          onClose={() => setPreviewData(null)}
        />
      )}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [authState, setAuthState] = useState({ loading: true, authenticated: false, user: null });
  const urlError = new URLSearchParams(window.location.search).get('error');

  useEffect(() => {
    if (urlError) {
      // Clean error param from URL without a reload
      window.history.replaceState({}, '', window.location.pathname);
    }
    fetch('/auth/status', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setAuthState({ loading: false, ...data }))
      .catch(() => setAuthState({ loading: false, authenticated: false, user: null }));
  }, []);

  if (authState.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <svg className="w-8 h-8 text-indigo-500 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
        </svg>
      </div>
    );
  }

  if (!authState.authenticated) {
    return <LoginScreen urlError={urlError} />;
  }

  return (
    <Dashboard
      user={authState.user}
      onLogout={() => setAuthState({ loading: false, authenticated: false, user: null })}
    />
  );
}
