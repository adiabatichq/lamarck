import { useCallback, useEffect, useState } from 'react';
import { aiSourceLogin, listAiSources, removeAiSource, saveAiSource, type AiLoginStatus, type AiSourceInput, type AppInfo, type ManagedAiSource } from '../lib/api';
import styles from './AiSources.module.css';

type Inventory = Awaited<ReturnType<typeof listAiSources>>;
const fresh = (): AiSourceInput => ({ name: '', provider: 'openai', kind: 'api-key', allow: { mode: 'all' }, config: {} });
export function AiSources({ apps }: { apps: AppInfo[] }) {
  const [inventory, setInventory] = useState<Inventory>({ models: [], accessSources: [], sources: [] });
  const [draft, setDraft] = useState<AiSourceInput | null>(null);
  const [editingId, setEditingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<{ id: string; state: AiLoginStatus }>();
  const refresh = useCallback(async () => setInventory(await listAiSources()), []);
  useEffect(() => { void refresh().catch(reason => setError(String(reason))); }, [refresh]);
  useEffect(() => {
    if (login?.state.status !== 'pending') return;
    let active = true;
    const timer = setInterval(() => { void aiSourceLogin(login.id, 'login-status').then(state => {
      if (!active) return;
      setLogin({ id: login.id, state });
      if (state.status === 'ready') void refresh();
    }).catch(reason => { if (active) setError(String(reason)); }); }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [login?.id, login?.state.status, refresh]);
  async function act(run: () => Promise<unknown>) {
    setBusy(true); setError(undefined);
    try { await run(); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  function edit(source: ManagedAiSource) {
    setEditingId(source.id);
    setDraft({ name: source.name, provider: source.provider, kind: source.kind, allow: source.allow, config: source.config });
  }
  return <div className={styles.page}>
    <header className={styles.header}>
      <div><span>Model access</span><h1>AI</h1><p>Choose how your Apps connect to language and embedding models.</p></div>
      <button disabled={busy} onClick={() => { setEditingId(undefined); setDraft(fresh()); }}>Add access source</button>
    </header>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {login && <aside className={styles.login} aria-live="polite">
      <strong>{login.state.status === 'pending' ? 'Complete subscription login' : `Login ${login.state.status}`}</strong>
      {login.state.url && <a href={login.state.url} onClick={event => {
        event.preventDefault();
        void window.lamarckHost?.openExternal(login.state.url!).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
      }}>Open login page ↗</a>}
      {login.state.message && <p>{login.state.message}</p>}
      {login.state.status === 'pending' && <button onClick={() => void act(async () => { await aiSourceLogin(login.id, 'cancel-login'); setLogin(undefined); })}>Cancel login</button>}
    </aside>}
    {draft && <form className={styles.form} onSubmit={event => {
      event.preventDefault(); void act(async () => { await saveAiSource(draft, editingId); setDraft(null); });
    }}>
      <h2>{editingId ? 'Edit access source' : 'New access source'}</h2>
      <label>Name<input required maxLength={120} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <div className={styles.fields}>
        <label>Provider<select disabled={!!editingId} value={draft.provider} onChange={event => setDraft({ ...draft, provider: event.target.value, kind: event.target.value === 'local' ? 'local' : 'api-key', config: {}, apiKey: undefined })}>
          <option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="local">Local service</option>
        </select></label>
        <label>Access<select disabled={!!editingId || draft.provider === 'local'} value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as AiSourceInput['kind'], apiKey: undefined })}>
          {draft.provider === 'local' ? <option value="local">OpenAI-compatible endpoint</option> : <><option value="api-key">API key</option><option value="subscription">{draft.provider === 'openai' ? 'Codex subscription' : 'Claude Code subscription'}</option></>}
        </select></label>
      </div>
      {draft.kind === 'api-key' && <label>{editingId ? 'Replace API key (leave blank to keep)' : 'API key'}<input type="password" autoComplete="off" required={!editingId} value={draft.apiKey ?? ''} onChange={event => setDraft({ ...draft, apiKey: event.target.value || undefined })} /></label>}
      {draft.kind === 'local' && <label>Service base URL<input type="url" required placeholder="http://localhost:11434/v1" value={draft.config?.endpoint ?? ''} onChange={event => setDraft({ ...draft, config: { endpoint: event.target.value } })} /><small>Uses the service’s model list and chat-completions streaming endpoint.</small></label>}
      {draft.kind === 'subscription' && <p>Save this source, then log in with its own subscription account.</p>}
      <fieldset><legend>Apps allowed to use this source</legend>
        <label className={styles.choice}><input type="radio" name="allow" checked={draft.allow?.mode === 'all'} onChange={() => setDraft({ ...draft, allow: { mode: 'all' } })} />Allow all Apps, including future Apps</label>
        <label className={styles.choice}><input type="radio" name="allow" checked={draft.allow?.mode === 'apps'} onChange={() => setDraft({ ...draft, allow: { mode: 'apps', appIds: [] } })} />Allow selected Apps</label>
        {draft.allow?.mode === 'apps' && <div className={styles.apps}>
          {apps.map(app => <label className={styles.choice} key={app.id}><input type="checkbox" checked={draft.allow?.mode === 'apps' && draft.allow.appIds.includes(app.id)} onChange={event => {
            const ids = draft.allow?.mode === 'apps' ? draft.allow.appIds : [];
            setDraft({ ...draft, allow: { mode: 'apps', appIds: event.target.checked ? [...ids, app.id] : ids.filter(id => id !== app.id) } });
          }} />{app.name} <small>{app.id}</small></label>)}
          <small>An empty selection allows no Apps.</small>
        </div>}
      </fieldset>
      <div className={styles.actions}><button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save source'}</button><button type="button" onClick={() => setDraft(null)}>Cancel</button></div>
    </form>}
    <section className={styles.sources} aria-label="Access sources">
      {!inventory.sources.length && <p className={styles.empty}>Add an API key, subscription account, or local service to get started.</p>}
      {inventory.sources.map(source => {
        const view = inventory.accessSources.find(item => item.id === source.id);
        return <article key={source.id} className={styles.source}>
          <div><h2>{source.name}</h2><p>{source.provider} · {source.kind} · <strong>{view?.status ?? 'Checking'}</strong></p>
            <small>{source.allow.mode === 'all' ? 'Allowed for all Apps' : `Allowed for ${source.allow.appIds.length} selected Apps`}</small></div>
          <div className={styles.actions}>
            <button disabled={busy} onClick={() => edit(source)}>Edit</button>
            {source.kind === 'subscription' && <button disabled={busy} onClick={() => void act(async () => setLogin({ id: source.id, state: await aiSourceLogin(source.id, 'login') }))}>Log in</button>}
            <button disabled={busy} onClick={() => void act(async () => { await removeAiSource(source.id); if (login?.id === source.id) setLogin(undefined); })}>Remove</button>
          </div>
          <details><summary>Models and capabilities ({view?.support.length ?? 0})</summary>
            {view?.discovery !== 'known' ? <p>Model support {view?.discovery === 'failed' ? 'could not be checked. Check the connection or log in again.' : 'is not yet known. Log in to discover available models.'}</p> : <ul>{view.support.map(support => <li key={support.model}><span>{support.model}</span><small>{support.maxEmbeddingsPerCall ? 'Embeddings' : ['Text', support.streaming && 'Streaming', support.structuredOutput && 'Structured output', support.tools && 'Tools'].filter(Boolean).join(' · ')}</small></li>)}</ul>}
          </details>
        </article>;
      })}
    </section>
    <details className={styles.catalog}><summary>Supported model catalog ({inventory.models.length})</summary><p>Models are independent of your configured access sources.</p><ul>{inventory.models.map(model => <li key={model.id}>{model.name} <small>{model.id} · {model.type}</small></li>)}</ul></details>
  </div>;
}
