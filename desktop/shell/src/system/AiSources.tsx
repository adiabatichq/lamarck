import { useCorePolling } from "../hooks/useCorePolling";
import { useCallback, useEffect, useRef, useState } from 'react';
import { aiSourceLogin, listAiSources, removeAiSource, saveAiSource, type AiLoginStatus, type AiSourceInput, type AppInfo, type ManagedAiSource } from '../lib/api';
import styles from './AiSources.module.css';

type Inventory = Awaited<ReturnType<typeof listAiSources>>;
type Login = { id: string; name: string; provider: string; attempt: number; starting: boolean; opened: boolean; state: AiLoginStatus; pollError?: string };
const fresh = (): AiSourceInput => ({ name: '', provider: 'openai', kind: 'api-key', allow: { mode: 'all' }, config: {} });
const providerName = (provider: string) => ({ openai: 'OpenAI', anthropic: 'Anthropic', local: 'Local service' })[provider] ?? provider;
const subscriptionName = (provider: string) => provider === 'openai' ? 'Codex' : 'Claude Code';
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export function AiSources({ apps }: { apps: AppInfo[] }) {
  const [inventory, setInventory] = useState<Inventory>({ models: [], accessSources: [], sources: [] });
  const [draft, setDraft] = useState<AiSourceInput | null>(null);
  const [editingId, setEditingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<Login>();
  const dialog = useRef<HTMLDialogElement>(null);
  const loginAttempt = useRef(0);
  const refresh = useCallback(async () => setInventory(await listAiSources()), []);
  useEffect(() => { void refresh().catch(reason => setError(errorMessage(reason))); }, [refresh]);
  const dialogView = draft ? 'form' : login ? login.state.status : undefined;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (dialogView) {
      if (!element.open) element.showModal();
      element.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    } else if (element.open) element.close();
  }, [dialogView]);
  const readLogin = useCallback(async (signal: AbortSignal) => {
    if (!login) return;
    try {
      const state = await aiSourceLogin(login.id, 'login-status', signal);
      if (signal.aborted || loginAttempt.current !== login.attempt) return;
      setLogin(current => current?.attempt === login.attempt ? { ...current, state, pollError: undefined } : current);
      if (state.status === 'ready') await refresh();
    } catch (reason) {
      if (!signal.aborted && loginAttempt.current === login.attempt) setLogin(current => current?.attempt === login.attempt ? { ...current, pollError: errorMessage(reason) } : current);
      throw reason;
    }
  }, [login?.id, login?.attempt, refresh]);
  useCorePolling(readLogin, 1500, !!login && !login.starting && login.state.status === 'pending');
  async function act(run: () => Promise<unknown>) {
    setBusy(true); setError(undefined);
    try { await run(); await refresh(); } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  async function beginLogin(source: Pick<ManagedAiSource, 'id' | 'name' | 'provider'>) {
    const attempt = ++loginAttempt.current;
    setDraft(null);
    setLogin({ id: source.id, name: source.name, provider: source.provider, attempt, starting: true, opened: false, state: { status: 'pending' } });
    try {
      const state = await aiSourceLogin(source.id, 'login');
      if (loginAttempt.current === attempt) setLogin(current => current?.attempt === attempt ? { ...current, state, starting: false } : current);
    } catch (reason) {
      if (loginAttempt.current === attempt) setLogin(current => current?.attempt === attempt ? { ...current, starting: false, state: { status: 'failed', message: errorMessage(reason) } } : current);
    }
  }
  async function openLoginPage() {
    if (!login?.state.url) return;
    const attempt = login.attempt;
    setError(undefined);
    try {
      if (!window.lamarckHost?.openExternal) throw new Error('Open this source in the Lamarck desktop app to sign in.');
      await window.lamarckHost.openExternal(login.state.url);
      setLogin(current => current?.attempt === attempt ? { ...current, opened: true } : current);
    } catch (reason) {
      if (loginAttempt.current === attempt) setError(errorMessage(reason));
    }
  }
  function closeDialog() {
    if (busy) return;
    if (login?.state.status === 'pending') {
      void act(async () => {
        await aiSourceLogin(login.id, 'cancel-login');
        loginAttempt.current++;
        setLogin(undefined);
      });
    } else {
      loginAttempt.current++;
      setLogin(undefined);
      setDraft(null);
      setError(undefined);
    }
  }
  function edit(source: ManagedAiSource) {
    setError(undefined);
    setEditingId(source.id);
    setDraft({ name: source.name, provider: source.provider, kind: source.kind, allow: source.allow, config: source.config });
  }
  return <div className={styles.page} aria-label="AI settings">
    <div className={styles.content}>
      <header className={styles.header}>
        <div><span className={styles.eyebrow}>Model access</span><h1>AI</h1><p>Connect the accounts and services your Apps use.</p></div>
        <button className={styles.primary} disabled={busy} onClick={() => { setError(undefined); setEditingId(undefined); setDraft(fresh()); }}>Add access source</button>
      </header>
      {error && !dialogView && <p role="alert" className={styles.error}>{error}</p>}
      <section className={styles.sources} aria-label="Access sources">
        {!inventory.sources.length && <div className={styles.empty}><h2>Your AI, connected</h2><p>Add an API key, sign in to Codex or Claude Code, or connect a local model.</p></div>}
        {inventory.sources.map(source => {
          const view = inventory.accessSources.find(item => item.id === source.id);
          const status = view?.status === 'ready' ? 'Connected' : view?.status === 'login-required' ? 'Sign-in needed' : view?.status === 'unavailable' ? 'Unavailable' : 'Checking…';
          return <article key={source.id} className={styles.source}>
            <div className={styles.sourceIdentity}>
              <span className={styles.providerMark} aria-hidden="true">{providerName(source.provider).slice(0, 1)}</span>
              <div><h2>{source.name}</h2><p>{providerName(source.provider)} · {source.kind === 'subscription' ? subscriptionName(source.provider) : source.kind === 'api-key' ? 'API key' : 'Local endpoint'}</p></div>
            </div>
            <span className={`${styles.status} ${view?.status === 'ready' ? styles.connected : ''}`}><i />{status}</span>
            <div className={styles.sourceFooter}>
              <small>{source.allow.mode === 'all' ? 'Allowed for all Apps' : `Allowed for ${source.allow.appIds.length} selected Apps`}</small>
              <div className={styles.actions}>
                {source.kind === 'subscription' && <button className={view?.status === 'ready' ? undefined : styles.primary} disabled={busy} onClick={() => void act(() => beginLogin(source))}>{view?.status === 'ready' ? 'Sign in again' : 'Sign in'}</button>}
                <button disabled={busy} onClick={() => edit(source)}>Edit</button>
                <button className={styles.quiet} disabled={busy} onClick={() => void act(async () => { await removeAiSource(source.id); })}>Remove</button>
              </div>
            </div>
            <details><summary>Models and capabilities ({view?.support.length ?? 0})</summary>
              {view?.discovery !== 'known' ? <p>Model support {view?.discovery === 'failed' ? 'could not be checked. Check the connection or sign in again.' : 'is not yet known. Sign in to see available models.'}</p> : <ul>{view.support.map(support => <li key={support.model}><span>{inventory.models.find(model => model.id === support.model)?.name ?? support.model}</span><small>{support.maxEmbeddingsPerCall ? 'Embeddings' : ['Text', support.streaming && 'Streaming', support.structuredOutput && 'Structured output', support.tools && 'Tools'].filter(Boolean).join(' · ')}</small></li>)}</ul>}
            </details>
          </article>;
        })}
      </section>
      <details className={styles.catalog}><summary>Supported model catalog ({inventory.models.length})</summary><p>Models are available through compatible access sources.</p><ul>{inventory.models.map(model => <li key={model.id}>{model.name} <small>{model.id} · {model.type}</small></li>)}</ul></details>
    </div>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="ai-dialog-title" onCancel={event => { event.preventDefault(); closeDialog(); }}>
      {draft ? <form onSubmit={event => {
        event.preventDefault();
        void act(async () => {
          const source = await saveAiSource(draft, editingId);
          if (!editingId && draft.kind === 'subscription') await beginLogin(source);
          else setDraft(null);
        });
      }}>
        <header className={styles.dialogHeader}>
          <div><span className={styles.eyebrow}>{editingId ? 'Connection settings' : 'Connect your AI'}</span><h2 id="ai-dialog-title">{editingId ? 'Edit access source' : 'Add access source'}</h2></div>
          <button type="button" className={styles.close} aria-label="Close" disabled={busy} onClick={closeDialog}>×</button>
        </header>
        <div className={styles.formBody}>
          {error && <p role="alert" className={styles.error}>{error}</p>}
          <div className={styles.fields}>
            <label>Provider<select disabled={!!editingId || busy} value={draft.provider} onChange={event => setDraft({ ...draft, provider: event.target.value, kind: event.target.value === 'local' ? 'local' : 'api-key', config: {}, apiKey: undefined })}>
              <option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="local">Local service</option>
            </select></label>
            <label>Connect with<select disabled={!!editingId || busy || draft.provider === 'local'} value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as AiSourceInput['kind'], apiKey: undefined })}>
              {draft.provider === 'local' ? <option value="local">Local endpoint</option> : <><option value="api-key">API key</option><option value="subscription">{subscriptionName(draft.provider)} sign-in</option></>}
            </select></label>
          </div>
          <label>Name<input data-initial-focus required maxLength={120} disabled={busy} placeholder={`My ${providerName(draft.provider)}`} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          {draft.kind === 'api-key' && <label>{editingId ? 'Replace API key' : 'API key'}<input type="password" autoComplete="off" disabled={busy} required={!editingId} value={draft.apiKey ?? ''} onChange={event => setDraft({ ...draft, apiKey: event.target.value || undefined })} />{editingId && <small>Leave blank to keep the current key.</small>}</label>}
          {draft.kind === 'local' && <label>Service URL<input type="url" required disabled={busy} placeholder="http://localhost:11434/v1" value={draft.config?.endpoint ?? ''} onChange={event => setDraft({ ...draft, config: { endpoint: event.target.value } })} /><small>Connect an OpenAI-compatible local service.</small></label>}
          {draft.kind === 'subscription' && <p className={styles.hint}>You'll sign in to {subscriptionName(draft.provider)} in your browser. Your password stays with {providerName(draft.provider)}.</p>}
          <fieldset disabled={busy}><legend>App access</legend>
            <label className={styles.choice}><input type="radio" name="allow" checked={draft.allow?.mode === 'all'} onChange={() => setDraft({ ...draft, allow: { mode: 'all' } })} /><span>All Apps<small>Includes Apps you add later.</small></span></label>
            <label className={styles.choice}><input type="radio" name="allow" checked={draft.allow?.mode === 'apps'} onChange={() => setDraft({ ...draft, allow: { mode: 'apps', appIds: [] } })} /><span>Selected Apps</span></label>
            {draft.allow?.mode === 'apps' && <div className={styles.apps}>
              {apps.map(app => <label className={styles.choice} key={app.id}><input type="checkbox" checked={draft.allow?.mode === 'apps' && draft.allow.appIds.includes(app.id)} onChange={event => {
                const ids = draft.allow?.mode === 'apps' ? draft.allow.appIds : [];
                setDraft({ ...draft, allow: { mode: 'apps', appIds: event.target.checked ? [...ids, app.id] : ids.filter(id => id !== app.id) } });
              }} /><span>{app.name}</span></label>)}
              <small>{apps.length ? 'No Apps selected means this source cannot be used by Apps.' : 'No Apps installed yet. You can choose Apps here later.'}</small>
            </div>}
          </fieldset>
        </div>
        <footer className={styles.dialogFooter}><button type="button" disabled={busy} onClick={closeDialog}>Cancel</button><button className={styles.primary} type="submit" disabled={busy}>{busy ? 'Saving…' : !editingId && draft.kind === 'subscription' ? 'Save and sign in' : 'Save source'}</button></footer>
      </form> : login && <div>
        <header className={styles.dialogHeader}>
          <span className={styles.eyebrow}>{providerName(login.provider)} · {login.name}</span>
          <button type="button" className={styles.close} aria-label="Close" disabled={busy} onClick={closeDialog}>×</button>
        </header>
        <div className={styles.loginBody} aria-live="polite">
          <span className={`${styles.loginMark} ${login.state.status === 'ready' ? styles.successMark : ''}`} aria-hidden="true">{login.state.status === 'ready' ? '✓' : login.state.status === 'failed' ? '!' : '↗'}</span>
          <h2 id="ai-dialog-title">{login.state.status === 'ready' ? `${subscriptionName(login.provider)} connected` : login.state.status === 'failed' ? 'Sign-in didn’t finish' : login.state.status === 'cancelled' ? 'Sign-in cancelled' : `Sign in to ${subscriptionName(login.provider)}`}</h2>
          <p>{login.state.status === 'ready' ? `${login.name} is ready for your allowed Apps.` : login.state.status === 'failed' ? 'Try signing in again to connect this source.' : login.state.status === 'cancelled' ? 'Your source is saved. You can sign in whenever you’re ready.' : login.opened ? `Complete sign-in in your browser, then return here. This window will update automatically.` : `Continue to ${providerName(login.provider)} in your browser to connect your account.`}</p>
          {login.provider === 'openai' && login.state.status === 'pending' && <p className={styles.hint}>If OpenAI asks for a workspace, choose your personal or team ChatGPT account. This is separate from your Lamarck workspace.</p>}
          {login.state.status === 'pending' && <div className={styles.loginProgress}><i />{login.starting || !login.state.url ? 'Preparing sign-in…' : login.opened ? 'Waiting for sign-in…' : 'Secure sign-in is ready'}</div>}
          {login.state.message && <p className={styles.hint}>{login.state.message}</p>}
          {(error || login.pollError) && <p role="alert" className={styles.error}>{error || login.pollError}</p>}
        </div>
        <footer className={styles.dialogFooter}>
          {login.state.status === 'pending' ? <>
            <button disabled={busy} onClick={closeDialog}>Cancel sign-in</button>
            {login.state.url && !login.starting ? <a data-initial-focus className={login.opened ? undefined : styles.primary} href={login.state.url} onClick={event => { event.preventDefault(); void openLoginPage(); }}>{login.opened ? 'Open sign-in again ↗' : 'Continue in browser ↗'}</a> : <button className={styles.primary} disabled>Preparing…</button>}
          </> : <>
            <button data-initial-focus className={login.state.status === 'ready' ? styles.primary : undefined} onClick={closeDialog}>{login.state.status === 'ready' ? 'Done' : 'Close'}</button>
            {login.state.status !== 'ready' && <button className={styles.primary} disabled={busy} onClick={() => void act(() => beginLogin(login))}>Try again</button>}
          </>}
        </footer>
      </div>}
    </dialog>
  </div>;
}
