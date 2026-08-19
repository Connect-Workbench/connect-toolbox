import React from 'react';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import type { Completion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { MySQL, sql } from '@codemirror/lang-sql';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as editorPlaceholder } from '@codemirror/view';
import type { ColumnDef } from './types';
import { t } from '../../i18n';

interface SqlFilterEditorProps {
  value: string;
  tableName: string;
  columns: ColumnDef[];
  onChange: (value: string) => void;
  onApply: () => void;
}

const editorTheme = EditorView.theme({
  '&': {
    minHeight: '32px',
    maxHeight: '32px',
    color: 'var(--vscode-input-foreground)',
    backgroundColor: 'transparent',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '3px',
    fontSize: '14px',
  },
  '.cm-scroller': {
    overflow: 'hidden',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
  },
  '.cm-content': {
    minHeight: '20px',
    padding: '5px 8px',
    caretColor: 'var(--vscode-editorCursor-foreground)',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-placeholder': {
    color: 'var(--vscode-input-placeholderForeground)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-background)',
    color: 'var(--vscode-editorSuggestWidget-foreground)',
    border: '1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-panel-border))',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground)',
    color: 'var(--vscode-editorSuggestWidget-selectedForeground)',
  },
});

export function SqlFilterEditor({
  value,
  tableName,
  columns,
  onChange,
  onApply,
}: SqlFilterEditorProps): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const onChangeRef = React.useRef(onChange);
  const onApplyRef = React.useRef(onApply);
  onChangeRef.current = onChange;
  onApplyRef.current = onApply;

  const columnSignature = React.useMemo(
    () => columns.map((column) => `${column.field}:${column.type}`).join('|'),
    [columns],
  );

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const completions: Completion[] = columns.map((column) => ({
      label: column.field,
      type: 'property',
      detail: column.type,
    }));
    const schema = tableName ? { [tableName]: completions } : {};
    const singleLineValue = value.replace(/[\r\n]+/g, ' ');
    const extensions = [
      sql({
        dialect: MySQL,
        schema,
        defaultTable: tableName || undefined,
        upperCaseKeywords: true,
      }),
      EditorState.changeFilter.of((transaction) => !transaction.newDoc.toString().includes('\n')),
      history(),
      autocompletion({ activateOnTyping: true }),
      keymap.of([
        {
          key: 'Enter',
          run: () => {
            onApplyRef.current();
            return true;
          },
        },
        indentWithTab,
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      editorPlaceholder(t('sqlFilterPlaceholder')),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
      editorTheme,
    ];
    const view = new EditorView({
      state: EditorState.create({ doc: singleLineValue, extensions }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [columnSignature, tableName]);

  React.useEffect(() => {
    const view = viewRef.current;
    const singleLineValue = value.replace(/[\r\n]+/g, ' ');
    if (!view || view.state.doc.toString() === singleLineValue) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: singleLineValue } });
  }, [value]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        borderBottom: '1px solid var(--vscode-panel-border)',
        background: 'transparent',
      }}
    >
      <span
        aria-label={t('sqlFilterTitle')}
        title={t('sqlFilterTitle')}
        style={{ color: 'var(--vscode-descriptionForeground)', fontSize: 13, fontWeight: 600, flexShrink: 0 }}
      >
        WHERE
      </span>
      <div ref={hostRef} style={{ flex: 1, minWidth: 0 }} aria-label={t('sqlFilterInput')} />
    </div>
  );
}
