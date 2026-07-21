import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { Schema } from '@tiptap/pm/model';
import type { Node as PMNode } from '@tiptap/pm/model';

import { TableView } from './table-view';
import { CustomTable } from './table';
import { TableRow } from './row';
import { TableCell } from './cell';
import { TableHeader } from './header';

/**
 * Regression guard for the table CPU burn.
 *
 * The table node had NO node view installed (the `View:` option only ever
 * reached prosemirror-tables' columnResizing plugin, whose nodeViews lose to
 * the direct EditorView prop), so ProseMirror fell back to its default
 * `ignoreMutation`, which returns false for every mutation on a node that has
 * a contentDOM. Every class write on `.tableWrapper` (the header-pin
 * controller) was then read as a foreign DOM change, ProseMirror re-rendered
 * the table, the wrapper died, the controller died, its replacement re-applied
 * the classes — ~150 `view.updateState` calls per second at idle, with header
 * pinning permanently broken as a bonus.
 *
 * These tests assert the two halves of the fix: the node view is actually
 * REGISTERED on the extension, and its `ignoreMutation` really does ignore
 * mutations outside `contentDOM`.
 */

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    table: {
      group: 'block',
      content: 'table_row+',
      isolating: true,
      attrs: { style: { default: null }, class: { default: null } },
      toDOM: () => ['table', ['tbody', 0]],
    },
    table_row: {
      content: 'table_cell+',
      toDOM: () => ['tr', 0],
    },
    table_cell: {
      content: 'inline*',
      attrs: { colspan: { default: 1 }, colwidth: { default: null } },
      toDOM: () => ['td', 0],
    },
  },
  marks: {},
});

function buildTable(attrs: Record<string, unknown> = {}): PMNode {
  const cell = (txt: string) =>
    schema.nodes.table_cell.createChecked(null, schema.text(txt));
  const row = schema.nodes.table_row.createChecked(null, [
    cell('a'),
    cell('b'),
  ]);
  return schema.nodes.table.createChecked(attrs, [row]);
}

// Attaches the view's DOM to the document so `closest()` and `contains()`
// behave the way they do in the editor.
function mount(view: TableView) {
  document.body.appendChild(view.dom);
  return view;
}

describe('TableView.ignoreMutation', () => {
  it('ignores attribute mutations on the wrapper (the CPU-burn driver)', () => {
    const view = mount(new TableView(buildTable(), 25));

    // Exactly what the header-pin controller does.
    view.dom.classList.add('tableHeaderPinned');

    expect(
      view.ignoreMutation({
        type: 'attributes',
        target: view.dom,
        attributeName: 'class',
      } as any),
    ).toBe(true);
  });

  it('ignores attribute and childList mutations on the <table> itself', () => {
    const view = mount(new TableView(buildTable(), 25));

    expect(
      view.ignoreMutation({
        type: 'attributes',
        target: view.table,
        attributeName: 'style',
      } as any),
    ).toBe(true);
    expect(
      view.ignoreMutation({
        type: 'childList',
        target: view.colgroup,
        addedNodes: [],
        removedNodes: [],
      } as any),
    ).toBe(true);
  });

  it('does NOT ignore mutations inside contentDOM', () => {
    const view = mount(new TableView(buildTable(), 25));
    const cell = document.createElement('td');
    view.contentDOM.appendChild(document.createElement('tr')).appendChild(cell);

    expect(
      view.ignoreMutation({
        type: 'attributes',
        target: cell,
        attributeName: 'colspan',
      } as any),
    ).toBe(false);
    expect(
      view.ignoreMutation({
        type: 'characterData',
        target: cell,
      } as any),
    ).toBe(false);
    expect(
      view.ignoreMutation({
        type: 'childList',
        target: cell,
        addedNodes: [document.createElement('span')],
        removedNodes: [],
      } as any),
    ).toBe(false);
  });

  it('does NOT ignore selection mutations on the wrapper', () => {
    const view = mount(new TableView(buildTable(), 25));

    expect(
      view.ignoreMutation({ type: 'selection', target: view.dom } as any),
    ).toBe(false);
  });

});

describe('TableView DOM shape and attributes', () => {
  it('builds div.tableWrapper > table > colgroup + tbody', () => {
    const view = mount(new TableView(buildTable(), 25));

    expect(view.dom.tagName).toBe('DIV');
    expect(view.dom.classList.contains('tableWrapper')).toBe(true);
    expect(view.dom.firstElementChild).toBe(view.table);
    expect(view.table.tagName).toBe('TABLE');
    expect(view.table.children[0].tagName).toBe('COLGROUP');
    expect(view.table.children[1]).toBe(view.contentDOM);
    expect(view.contentDOM.tagName).toBe('TBODY');
  });

  it('applies the rendered HTML attributes to the <table>', () => {
    const node = buildTable({ class: 'my-table' });
    const view = mount(
      new TableView(node, 25, {
        renderAttributes: (n) => ({ class: n.attrs.class, 'data-x': '1' }),
      }),
    );

    expect(view.table.getAttribute('class')).toBe('my-table');
    expect(view.table.getAttribute('data-x')).toBe('1');
  });

  it('re-applies changed attributes on update() and drops removed ones', () => {
    const view = mount(
      new TableView(buildTable({ class: 'before' }), 25, {
        renderAttributes: (n) =>
          n.attrs.class ? { class: n.attrs.class } : { 'data-y': 'now' },
      }),
    );
    expect(view.table.getAttribute('class')).toBe('before');

    expect(view.update(buildTable({ class: 'after' }))).toBe(true);
    expect(view.table.getAttribute('class')).toBe('after');

    // The `class` attribute disappears from the rendered set entirely.
    expect(view.update(buildTable({ class: null }))).toBe(true);
    expect(view.table.hasAttribute('class')).toBe(false);
    expect(view.table.getAttribute('data-y')).toBe('now');
  });

  it('re-applies node.attrs.style on update()', () => {
    const view = mount(new TableView(buildTable({ style: null }), 25));

    view.update(buildTable({ style: 'background: red' }));

    expect(view.table.style.background).toBe('red');
  });

  it('returns false from update() when the node type differs', () => {
    const view = mount(new TableView(buildTable(), 25));
    const paragraph = schema.nodes.paragraph.createChecked(null);

    expect(view.update(paragraph)).toBe(false);
  });
});

describe('CustomTable node view registration', () => {
  it('registers a node view for the table node', () => {
    expect(CustomTable.name).toBe('table');
    expect((CustomTable as any).config.addNodeView).toBeTypeOf('function');
  });

  it('produces a node view with dom, contentDOM and ignoreMutation', () => {
    const context = {
      name: 'table',
      options: { cellMinWidth: 49, HTMLAttributes: { class: 'from-options' } },
      // No extension manager: the factory must fall back to the HTMLAttributes
      // it was handed rather than dropping every attribute.
      editor: undefined,
    };
    const factory = (CustomTable as any).config.addNodeView.call(context);
    const nodeView = factory({
      node: buildTable(),
      HTMLAttributes: { 'data-id': 'abc' },
    });

    expect(nodeView.dom.classList.contains('tableWrapper')).toBe(true);
    expect(nodeView.contentDOM.tagName).toBe('TBODY');
    expect(nodeView.ignoreMutation).toBeTypeOf('function');
    expect(nodeView.table.getAttribute('data-id')).toBe('abc');
    expect(nodeView.table.getAttribute('class')).toBe('from-options');

    // And the whole point: wrapper attribute writes are ignored.
    expect(
      nodeView.ignoreMutation({
        type: 'attributes',
        target: nodeView.dom,
        attributeName: 'class',
      }),
    ).toBe(true);
  });
});

/**
 * The unit tests above call TableView directly, so they would ALL stay green if
 * the node view stopped owning the table DOM again — which is the exact failure
 * that caused this bug (the `View:` option went to a plugin that was never in
 * the plugin set). These tests therefore drive a REAL Editor and assert on the
 * observable property: a class write on the wrapper produces no `updateState`
 * and does not destroy the wrapper, while real content edits still reach the
 * document.
 */
describe('table node view in a real editor', () => {
  const editors: Editor[] = [];

  afterEach(() => {
    while (editors.length) editors.pop()!.destroy();
    document.body.innerHTML = '';
  });

  /**
   * `resizable` defaults to FALSE here on purpose, and that models production:
   * the body editor is constructed with `editable: false` (page-editor.tsx) and
   * only flipped later via setEditable, which does not rebuild plugins — so
   * tiptap's `isResizable = resizable && editor.isEditable` is false and
   * prosemirror-tables' columnResizing (which would install ITS OWN table node
   * view as a fallback) is never in the plugin set. With `resizable: true` that
   * fallback view masks the regression: removing our `addNodeView` still yields
   * 0 updateState calls, because pm-tables' view also ignores wrapper
   * attribute mutations. Measured, not assumed — see the ownership test below.
   */
  function makeEditor({
    resizable = false,
    HTMLAttributes,
  }: { resizable?: boolean; HTMLAttributes?: Record<string, any> } = {}) {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: [
        Document,
        Paragraph,
        Text,
        CustomTable.configure({
          resizable,
          cellMinWidth: 49,
          ...(HTMLAttributes ? { HTMLAttributes } : {}),
        }),
        TableRow,
        // The real cell/header content expressions name a dozen block nodes
        // (heading, callout, …) that this minimal editor does not load, so the
        // schema would not build. Only the table node itself is under test.
        TableCell.extend({ content: 'paragraph+' }),
        TableHeader.extend({ content: 'paragraph+' }),
      ],
      content:
        '<table><tbody><tr><th>a</th><th>b</th></tr><tr><td>c</td><td>d</td></tr></tbody></table>',
    });
    editors.push(editor);
    return { editor, element };
  }

  it('does not re-render the table when the wrapper class changes', () => {
    const { editor, element } = makeEditor();
    const view: any = editor.view;

    let updates = 0;
    const originalUpdateState = view.updateState.bind(view);
    view.updateState = (state: any) => {
      updates += 1;
      return originalUpdateState(state);
    };

    const wrapper = element.querySelector('.tableWrapper')!;
    expect(wrapper).toBeTruthy();

    // Exactly what the header-pin controller does.
    wrapper.classList.add('tableHeaderPinned');
    view.domObserver.flush();

    expect(updates).toBe(0);
    // The wrapper survives, so the pin controller bound to it survives too.
    expect(element.querySelector('.tableWrapper')).toBe(wrapper);
    expect(wrapper.classList.contains('tableHeaderPinned')).toBe(true);
  });

  it('owns the table DOM even when columnResizing contributes its own view', () => {
    // Guards the historical failure mode directly: the configured owner was
    // never the one ProseMirror actually used. Our node view is a direct
    // EditorView prop, so it must win someProp('nodeViews') over the plugin's.
    const { element } = makeEditor({ resizable: true });
    const wrapper: any = element.querySelector('.tableWrapper')!;

    expect(wrapper.pmViewDesc.spec).toBeInstanceOf(TableView);
  });

  it('still lets real content edits inside the table reach the document', () => {
    const { editor, element } = makeEditor();
    const view: any = editor.view;

    const paragraph = element.querySelector('td p')!;
    paragraph.appendChild(document.createTextNode('ZZZ'));
    view.domObserver.flush();

    expect(editor.state.doc.textContent).toContain('ZZZ');
  });

  it('applies a new row added straight into the tbody', () => {
    const { editor, element } = makeEditor();
    const view: any = editor.view;

    const tbody = element.querySelector('tbody')!;
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.appendChild(document.createElement('p')).textContent = 'QQQ';
    row.appendChild(cell);
    tbody.appendChild(row);
    view.domObserver.flush();

    expect(editor.state.doc.textContent).toContain('QQQ');
  });

  // The node view and renderHTML are two renderings of the same node — the
  // repo rules reject "keep these in sync by hand", so this is the machine
  // check. Configured HTMLAttributes are included because they are the part
  // the node view has to reproduce deliberately.
  it.each([
    ['no configured attributes', undefined],
    [
      'configured HTMLAttributes',
      { class: 'my-table', 'data-kind': 'grid' } as Record<string, any>,
    ],
  ])('keeps the live table DOM in sync with getHTML() — %s', (_label, attrs) => {
    const { editor, element } = makeEditor({ HTMLAttributes: attrs });

    const live = element.querySelector('.tableWrapper')!.outerHTML;

    // getHTML() wraps the table in whatever the doc holds; compare only the
    // wrapper. jsdom serializes inline styles with a trailing "; " that the
    // static renderer does not emit, so normalise that away.
    const rendered = editor.getHTML();
    const start = rendered.indexOf('<div class="tableWrapper">');
    const end = rendered.lastIndexOf('</div>') + '</div>'.length;
    const exported = rendered.slice(start, end);

    const normalise = (html: string) =>
      html.replace(
        /style="([^"]*)"/g,
        (_m, css: string) =>
          `style="${css.replace(/\s*;\s*$/, '').replace(/\s+/g, ' ').trim()}"`,
      );

    expect(normalise(live)).toBe(normalise(exported));
  });
});
