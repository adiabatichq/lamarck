import { system } from '@lamarck/system/browser';
import { generateText, streamText, tool, Output } from 'ai';
import { z } from 'zod';
const assert = (condition: unknown) => { if (!condition) throw new Error('Renderer assertion failed'); };
Object.assign(window, {
  async exercise(accessSource: string) {
    assert(typeof (globalThis as any).require === 'undefined');
    assert(Object.keys((globalThis as any).__LAMARCK_SYSTEM_HOST__).join() === 'invoke');
    const selection = { model: 'openai:fixture', accessSource };
    assert((await system.ai.listOptions()).accessSources[0].id === accessSource);
    assert((await generateText({ model: system.ai.languageModel(selection), prompt: 'hi' })).text === 'hello');
    let text = ''; for await (const part of streamText({ model: system.ai.languageModel(selection), prompt: 'hi' }).textStream) text += part;
    assert(text === 'hello');
    let calls = 0;
    const tools = { lookup: tool({ inputSchema: z.object({ value: z.string() }), execute: async () => { calls++; const result = await system.query('fixture'); assert(result.rows[0].appId === 'browser-fixture'); return 'answer'; } }) };
    await system.ai.withTools({ ...selection, tools }, async ({ model, tools }) => generateText({ model, tools, prompt: 'lookup' })); assert(calls === 1);
    for (const rejected of [false, true]) {
      let validations = 0;
      const schema = z.object({ answer: z.number() }).superRefine(async (_, context) => {
        validations++;
        const { rows } = await system.query('timeline-count');
        assert(rows[0].count === 0);
        if (rejected) context.addIssue({ code: 'custom', message: 'fixture validation' });
      });
      const outcome = await generateText({ model: system.ai.languageModel(selection), prompt: 'JSON', output: Output.object({ schema }) }).then(() => 'accepted', () => 'rejected');
      assert(outcome === (rejected ? 'rejected' : 'accepted')); assert(validations === 1);
    }
    const retry = streamText({ model: system.ai.languageModel(selection), prompt: 'retry-stream', streamRetries: 1,
      onError: async () => { await system.query('retry-poll'); } });
    await retry.consumeStream(); assert(await retry.text === 'hello');
    const controller = new AbortController();
    const pending = generateText({ model: system.ai.languageModel(selection), prompt: 'abort-me', abortSignal: controller.signal, maxRetries: 0 });
    setTimeout(() => controller.abort(), 100);
    let cancelled = false; try { await pending; } catch { cancelled = true; } assert(cancelled);
    return 'passed';
  },
  pending(accessSource: string) { void generateText({ model: system.ai.languageModel({ model: 'openai:fixture', accessSource }), prompt: 'abort-me', maxRetries: 0 }).catch(() => {}); },
});

import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { AiSources } from '../../desktop/shell/src/system/AiSources';
import '../../desktop/shell/src/styles/tokens.css';
import '../../desktop/shell/src/styles/reset.css';
import '../../desktop/shell/src/styles/global.css';
const externalUrls: string[] = [];
let consoleBase = '', failNextExternal = false;
const wait = async (predicate: () => unknown) => { for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Console timed out'); };
const button = (name: string, root: ParentNode = document) => [...root.querySelectorAll('button')].find(button => button.textContent === name)!;
const set = (selector: string, value: string) => {
  const input = document.querySelector(selector)!;
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};
const dialog = () => document.querySelector('dialog')!;
const page = () => document.querySelector<HTMLElement>('[aria-label="AI settings"]')!;
const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const setLoginState = async (status: string) => {
  await fetch(`${consoleBase}/fixture/login-state`, { method: 'POST', headers: { Authorization: 'Bearer console-fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
};
Object.assign(window, {
  showConsole(base: string) {
    consoleBase = base;
    Object.assign(window, { lamarckHost: { getCoreBaseUrl: async () => base, getCoreToken: async () => 'console-fixture', getCoreRuntimeState: async () => ({ phase: 'ready', generation: 1 }), onCoreRuntimeState: () => () => {}, openExternal: async (url: string) => {
      if (failNextExternal) { failNextExternal = false; throw new Error('Could not open the browser. Please try again.'); }
      externalUrls.push(url);
    } } });
    // Match SystemRoom's bounded, non-scrolling content container.
    const element = document.createElement('main'); element.style.cssText = 'height:100%;min-height:0;overflow:hidden'; document.body.append(element);
    createRoot(element).render(createElement(AiSources, { apps: [{ id: 'browser-fixture', name: 'Fixture App' } as any] }));
  },
  async exerciseConsole() {
    const article = () => [...document.querySelectorAll('article')].find(article => article.textContent?.includes('Console fixture'))!;
    await wait(() => button('Add access source')); button('Add access source').click();
    await wait(() => document.querySelector('form') && dialog().open);
    set('form input:not([type])', 'Console fixture'); set('form input[type=password]', 'fixture-secret');
    button('Save source').click(); await wait(() => article() && !dialog().open && !button('Add access source').disabled);
    button('Edit', article()).click(); await wait(() => document.querySelector('form'));
    assert((document.querySelector('form input[type=password]') as HTMLInputElement).value === '');
    (document.querySelectorAll('form input[type=radio]')[1] as HTMLInputElement).click();
    button('Save source').click(); await wait(() => article().textContent?.includes('0 selected Apps') && !dialog().open && !button('Add access source').disabled);
    button('Edit', article()).click(); await wait(() => document.querySelector('form'));
    assert((document.querySelectorAll('form input[type=radio]')[1] as HTMLInputElement).checked);
    assert(!document.body.textContent?.includes('fixture-secret'));
    // Escape-style cancellation closes the dialog and restores the source list.
    dialog().dispatchEvent(new Event('cancel', { cancelable: true })); await wait(() => !dialog().open);
    (document.querySelector('details:last-of-type') as HTMLDetailsElement).open = true;
    await settle();
    assert(page().scrollHeight > page().clientHeight);
    page().scrollTop = page().scrollHeight; await settle();
    assert(page().scrollTop > 0 && page().getBoundingClientRect().bottom <= innerHeight + 1);
    page().scrollTop = 0;
    button('Add access source').click(); await wait(() => dialog().open && document.querySelector('form'));
    set('form select:nth-of-type(1)', 'openai');
    const selects = document.querySelectorAll('form select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(selects[1], 'subscription');
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    set('form input:not([type])', 'Codex personal');
    await wait(() => button('Save and sign in')); button('Save and sign in').click();
    await wait(() => dialog().textContent?.includes('Sign in to Codex') && document.querySelector('a[href="https://example.invalid/subscription-login"]'));
    assert(dialog().textContent?.includes('personal or team ChatGPT account'));
    const loginLink = () => document.querySelector('a[href="https://example.invalid/subscription-login"]')!;
    failNextExternal = true;
    assert(!loginLink().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await wait(() => dialog().textContent?.includes('Could not open the browser'));
    assert(!loginLink().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await wait(() => externalUrls.length === 1 && dialog().textContent?.includes('Waiting for sign-in'));
    assert(externalUrls[0] === 'https://example.invalid/subscription-login');
    await setLoginState('ready'); await wait(() => button('Done'));
    assert(dialog().textContent?.includes('Codex connected'));
    button('Done').click(); await wait(() => !dialog().open);
    const subscription = () => [...document.querySelectorAll('article')].find(article => article.querySelector('h2')?.textContent === 'Codex personal')!;
    button('Sign in again', subscription()).click(); await wait(() => loginLink() && !button('Cancel sign-in').disabled);
    button('Cancel sign-in').click(); await wait(() => !dialog().open && !button('Add access source').disabled);
    button('Sign in again', subscription()).click(); await wait(() => loginLink() && !button('Cancel sign-in').disabled);
    await setLoginState('failed'); await wait(() => button('Try again'));
    assert(dialog().textContent?.includes('Sign-in didn’t finish'));
    button('Try again').click(); await wait(() => loginLink() && !button('Cancel sign-in').disabled);
    await settle();
    return 'passed';
  },
  async exerciseConsoleLayout() {
    await settle();
    assert(dialog().open && dialog().scrollHeight > dialog().clientHeight);
    assert(dialog().scrollWidth <= dialog().clientWidth + 1);
    dialog().scrollTop = dialog().scrollHeight; await settle();
    const action = button('Cancel sign-in').getBoundingClientRect();
    assert(action.top >= 0 && action.bottom <= innerHeight);
    dialog().scrollTop = 0;
    await settle();
  },
});
