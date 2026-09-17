import { system } from '@lamarck/system/browser';
import { generateText, streamText, tool } from 'ai';
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
Object.assign(window, {
  showConsole(base: string) {
    Object.assign(window, { lamarckHost: { getCoreBaseUrl: async () => base, getCoreToken: async () => 'console-fixture', openExternal: async (url: string) => { externalUrls.push(url); } } });
    const element = document.createElement('main'); document.body.append(element);
    createRoot(element).render(createElement(AiSources, { apps: [{ id: 'browser-fixture', name: 'Fixture App' } as any] }));
  },
  async exerciseConsole() {
    const wait = async (predicate: () => unknown) => { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Console timed out'); };
    const button = (name: string, root: ParentNode = document) => [...root.querySelectorAll('button')].find(button => button.textContent === name)!;
    const article = () => [...document.querySelectorAll('article')].find(article => article.textContent?.includes('Console fixture'))!;
    await wait(() => button('Add access source')); button('Add access source').click();
    await wait(() => document.querySelector('form'));
    const set = (selector: string, value: string) => { const input = document.querySelector(selector)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
    set('form input:not([type])', 'Console fixture'); set('form input[type=password]', 'fixture-secret');
    button('Save source').click(); await wait(() => article() && !document.querySelector('form') && !button('Add access source').disabled);
    button('Edit', article()).click(); await wait(() => document.querySelector('form'));
    assert((document.querySelector('form input[type=password]') as HTMLInputElement).value === '');
    (document.querySelectorAll('form input[type=radio]')[1] as HTMLInputElement).click();
    button('Save source').click(); await wait(() => article().textContent?.includes('0 selected Apps') && !document.querySelector('form') && !button('Add access source').disabled);
    button('Edit', article()).click(); await wait(() => document.querySelector('form'));
    assert((document.querySelectorAll('form input[type=radio]')[1] as HTMLInputElement).checked);
    assert(!document.body.textContent?.includes('fixture-secret'));
    button('Log in').click();
    await wait(() => document.querySelector('a[href="https://example.invalid/subscription-login"]'));
    const login = document.querySelector('a[href="https://example.invalid/subscription-login"]')!;
    assert(!login.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await wait(() => externalUrls.length === 1);
    assert(externalUrls[0] === 'https://example.invalid/subscription-login');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return 'passed';
  },
});
