import React from 'react';

export interface ColumnPrefs {
  order: string[];
  visible: Record<string, boolean>;
  widths: Record<string, number>;
  marked: string[];
}

const EMPTY_PREFS: ColumnPrefs = { order: [], visible: {}, widths: {}, marked: [] };

const STORAGE_PREFIX = 'ct.prefs.';

function keyFor(db: string, table: string): string {
  return STORAGE_PREFIX + db + '.' + table;
}

function load(db: string, table: string): ColumnPrefs | null {
  try {
    const raw = localStorage.getItem(keyFor(db, table));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ColumnPrefs>;
    return {
      ...EMPTY_PREFS,
      ...parsed,
      marked: Array.isArray(parsed.marked) ? parsed.marked : [],
    };
  } catch {
    return null;
  }
}

function save(db: string, table: string, prefs: ColumnPrefs): void {
  try {
    localStorage.setItem(keyFor(db, table), JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

/**
 * 列偏好（顺序/显隐/宽度/标记）持久化 hook，按 库.表 独立存储。
 */
export function useColumnPrefs(database: string, table: string) {
  const [prefs, setPrefs] = React.useState<ColumnPrefs>(() => load(database, table) ?? EMPTY_PREFS);
  const dbRef = React.useRef(database);
  const tableRef = React.useRef(table);
  dbRef.current = database;
  tableRef.current = table;

  React.useEffect(() => {
    setPrefs(load(database, table) ?? EMPTY_PREFS);
  }, [database, table]);

  const update = React.useCallback((fn: (p: ColumnPrefs) => ColumnPrefs) => {
    setPrefs((prev) => {
      const next = fn(prev);
      save(dbRef.current, tableRef.current, next);
      return next;
    });
  }, []);

  const toggleVisible = React.useCallback(
    (field: string, visible: boolean) => update((p) => {
      const vis = { ...p.visible };
      if (visible) delete vis[field];
      else vis[field] = false;
      return { ...p, visible: vis };
    }),
    [update],
  );
  const toggleAllVisible = React.useCallback((fields: string[]) => update((p) => {
    const allVisible = fields.every((field) => p.visible[field] !== false);
    return {
      ...p,
      visible: allVisible
        ? Object.fromEntries(fields.map((field) => [field, false]))
        : {},
    };
  }), [update]);
  const resetOrder = React.useCallback(() => update((p) => ({ ...p, order: [] })), [update]);
  const setWidth = React.useCallback((field: string, width: number) => update((p) => ({ ...p, widths: { ...p.widths, [field]: width } })), [update]);
  const toggleMarked = React.useCallback((field: string) => update((p) => ({
    ...p,
    marked: p.marked.includes(field)
      ? p.marked.filter((item) => item !== field)
      : [...p.marked, field],
  })), [update]);

  return { ...prefs, toggleVisible, toggleAllVisible, resetOrder, setWidth, toggleMarked };
}
