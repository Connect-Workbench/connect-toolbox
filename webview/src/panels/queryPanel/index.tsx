import React from 'react';
import { Typography, Alert } from 'antd';
import { onMessage, postMessage } from '../../vscodeBridge';
import DataGrid from '../../components/DataGrid';
import { t } from '../../i18n';

interface ResultTab {
  columns: string[];
  rows: Record<string, unknown>[];
  affectedRows?: number;
  insertId?: number;
  durationMs: number;
  statement: string;
}

interface ResultsPayload {
  tabs: ResultTab[];
  sql?: string;
  error?: { message: string; statementIndex?: number; statementText?: string };
}

interface InitPayload {
  connectionName: string;
}

type Incoming =
  | { type: 'init'; payload: InitPayload }
  | { type: 'results'; payload: ResultsPayload };

/**
 * 查询结果面板（?panel=query）：
 * - 顶部：连接名（库上下文由打开的 .sql 编辑器文件名指示：`连接名_库名`）
 * - 主体：一次 Run 的多条语句结果按 resultTabs 分 tab 展示
 * - 出错：遇错即停，展示失败语句信息
 *
 * 注：不在结果面板里做库切换。想切库就在连接树的对应库节点上点「新建查询」。
 */
export default function QueryResultPanel(): React.JSX.Element {
  const [connectionName, setConnectionName] = React.useState('');
  const [tabs, setTabs] = React.useState<ResultTab[]>([]);
  const [activeTab, setActiveTab] = React.useState(0);
  const [error, setError] = React.useState<ResultsPayload['error']>(undefined);
  const [ranSql, setRanSql] = React.useState('');

  React.useEffect(() => {
    return onMessage<Incoming>((m) => {
      if (m.type === 'init') {
        setConnectionName(m.payload.connectionName);
      } else if (m.type === 'results') {
        setError(m.payload.error);
        setRanSql(m.payload.sql ?? '');
        setTabs(m.payload.tabs);
        setActiveTab(0);
      }
    });
  }, []);

  // 就绪握手：告诉 host 本面板已挂载并注册了消息监听，可安全推送 init/结果
  React.useEffect(() => {
    postMessage({ type: 'ready' });
  }, []);

  const tab = tabs[activeTab];
  const isSelect = tab && tab.columns.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* 顶栏：连接名 */}
      <div
        style={{
          padding: '6px 10px',
          borderBottom: '1px solid var(--vscode-panel-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexShrink: 0,
        }}
      >
        <Typography.Text strong style={{ fontSize: 12 }}>{connectionName}</Typography.Text>
        {ranSql && (
          <Typography.Text type="secondary" style={{ fontSize: 11, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ranSql}>
            {ranSql}
          </Typography.Text>
        )}
      </div>

      {/* 结果 tab 条 */}
      {tabs.length > 0 && (
        <div style={{ display: 'flex', gap: 2, padding: '6px 10px 0', flexShrink: 0 }}>
          {tabs.map((r, i) => {
            const label = r.columns.length > 0
              ? t('queryRows', { count: r.rows.length, duration: r.durationMs })
              : t('queryAffected', { count: r.affectedRows ?? 0, duration: r.durationMs });
            return (
              <div
                key={i}
                onClick={() => setActiveTab(i)}
                style={{
                  padding: '3px 10px',
                  border: '1px solid var(--vscode-panel-border)',
                  borderBottom: 'none',
                  borderRadius: '4px 4px 0 0',
                  fontSize: 12,
                  cursor: 'pointer',
                  background: i === activeTab ? 'var(--vscode-button-background)' : 'transparent',
                  color: i === activeTab ? 'var(--vscode-button-foreground)' : 'var(--vscode-descriptionForeground)',
                  maxWidth: 320,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={label}
              >
                {label}
              </div>
            );
          })}
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <Alert
          type="error"
          showIcon
          style={{ margin: 8, flexShrink: 0 }}
          message={
            error.statementIndex
              ? t('queryStatementFailed', { index: error.statementIndex, message: error.message })
              : t('queryError', { message: error.message })
          }
          description={error.statementText}
        />
      )}

      {/* 结果主体 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tabs.length === 0 && !error ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-descriptionForeground)' }}>
            {t('queryEmpty')}
          </div>
        ) : !tab ? null : isSelect ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-descriptionForeground)' }}>
            {t('queryNoResult')}
          </div>
        ) : (
          <DataGrid columns={tab.columns} rows={tab.rows} />
        )}
      </div>
    </div>
  );
}
