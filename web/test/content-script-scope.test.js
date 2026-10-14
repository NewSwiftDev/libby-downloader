import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');

function readAssembled(name) {
  return readFileSync(join(root, 'Shared (Extension)/Resources', name), 'utf8');
}

function topLevelLexicalBindings(source) {
  const bindings = [];
  let i = 0;
  let depth = 0;
  let quote = '';
  let escape = false;
  let line = 1;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (quote === '`') {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '`') {
        quote = '';
      } else if (char === '\n') {
        line += 1;
      }
      i += 1;
      continue;
    }

    if (quote) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === quote) quote = '';
      else if (char === '\n') line += 1;
      i += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      escape = false;
      i += 1;
      continue;
    }
    if (char === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (char === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      i += 1;
      continue;
    }

    if (depth === 0) {
      const match = /^(const|let|class)\s+([A-Za-z_$][\w$]*)/.exec(source.slice(i));
      if (match) {
        bindings.push({ kind: match[1], name: match[2], line });
        i += match[0].length;
        continue;
      }
    }
    i += 1;
  }

  return bindings;
}

function playerRealm() {
  const posted = [];
  const created = [];
  const listeners = [];
  const nav = {
    querySelectorAll() {
      return [];
    },
    appendChild(node) {
      this.child = node;
      return node;
    },
    insertBefore() {},
  };
  const document = {
    readyState: 'complete',
    documentElement: {},
    body: { appendChild() {} },
    getElementById() {
      return null;
    },
    getElementsByTagName() {
      return [];
    },
    querySelector(selector) {
      return selector === '.nav-action-bar-right' ? nav : null;
    },
    createElement() {
      const node = {
        style: {},
        children: [],
        listeners: {},
        className: '',
        id: '',
        innerHTML: '',
        setAttribute() {},
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        addEventListener(type, fn) {
          this.listeners[type] = fn;
        },
        remove() {},
      };
      created.push(node);
      return node;
    },
    addEventListener() {},
  };
  const sandbox = {
    console,
    document,
    location: {
      origin: 'https://listen.libbyapp.com',
      href: 'https://listen.libbyapp.com/player',
      pathname: '/open/loan/1',
    },
    JSON: {
      parse: JSON.parse,
      stringify: JSON.stringify,
    },
    Response: class Response {
      json() {
        return Promise.resolve(null);
      }
    },
    setTimeout,
    clearTimeout,
    URL,
    navigator: { userAgent: 'Safari' },
    parent: {
      postMessage(data) {
        posted.push(data);
      },
    },
    browser: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listeners.push(fn);
          },
        },
        sendMessage() {
          return Promise.resolve({ success: true });
        },
      },
    },
    alert() {},
    addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, posted, created, listeners, nav };
}

describe('Safari content-script scope', () => {
  const scripts = ['content.js', 'iframe-extractor.js', 'iframe-ui.js'].map((name) => ({
    name,
    source: readAssembled(name),
  }));

  it('does not leave const or let bindings in the shared content-script scope', () => {
    for (const script of scripts) {
      assert.deepEqual(topLevelLexicalBindings(script.source), [], script.name);
      assert.match(script.source, /const MessageTypes/);
    }
  });

  it('loads the player extractor and download button in one world, including a second injection', () => {
    const { sandbox, posted, created } = playerRealm();
    const extractor = readAssembled('iframe-extractor.js');
    const ui = readAssembled('iframe-ui.js');
    const content = readAssembled('content.js');
    const originalParse = sandbox.JSON.parse;

    vm.runInContext(extractor, sandbox);
    vm.runInContext(ui, sandbox);
    vm.runInContext(content, sandbox);
    const hookedParse = sandbox.JSON.parse;
    assert.notEqual(hookedParse, originalParse);

    assert.doesNotThrow(() => {
      vm.runInContext(extractor, sandbox);
      vm.runInContext(ui, sandbox);
      vm.runInContext(content, sandbox);
    });
    assert.equal(sandbox.JSON.parse, hookedParse);

    const button = created.find((node) => node.id === 'libby-downloader-button');
    assert.ok(button, 'download button was not created');
    button.listeners.click();
    assert.equal(posted.at(-1).type, 'LIBBY_DOWNLOADER_BUTTON_CLICKED');
  });
});
