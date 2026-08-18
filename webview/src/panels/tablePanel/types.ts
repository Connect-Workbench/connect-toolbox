import React from 'react';

/** 列定义（与主进程 describeTable 对齐） */
export interface ColumnDef {
  field: string;
  type: string;
  nullable: boolean;
  key: string;
  default: unknown;
  extra: string;
}

/** 单元格值（主进程已序列化：Date→ISO、Buffer→{__type:'hex',value}、bigint→string） */
export type CellValue = string | number | null | { __type: 'hex'; value: string };

export interface PagePayload {
  connectionName: string;
  database: string;
  table: string;
  columns: ColumnDef[];
  rows: Record<string, CellValue>[];
  total: number;
  page: number;
  pageSize: number;
  hasPk: boolean;
  pkColumns: string[];
}

export interface PanelMessage {
  type: 'page' | 'error' | 'commitResult' | 'cellEdited';
  payload?: PagePayload | CellEditedPayload;
  message?: string;
  ok?: boolean;
}

/** 单元格编辑器保存结果（写回本地暂存） */
export interface CellEditedPayload {
  rowKey: string;
  field: string;
  value: string;
  /** 编辑前的原值（用于判断是否真正改动） */
  originalValue?: string;
  pkValues?: string[];
}

/** 本地变更（暂存，Commit 后一次性提交） */
export interface LocalRow {
  /** 本地行标识：服务端 r-{index}，草稿 d-{ts} */
  __key: string;
  /** 行状态：normal / new（复制新增）/ deleted（标记删除）/ modified（已修改） */
  __status: 'normal' | 'new' | 'deleted' | 'modified';
  /** 草稿复制来源行在服务端数据中的下标（插入位置跟随） */
  __afterIndex?: number;
  /** 主键定位值（修改/删除用，原始行主键） */
  __pkValues?: string[];
  [field: string]: unknown;
}

export interface CommitPayload {
  /** 新增行：字段值（空串→NULL） */
  inserts: Record<string, string>[];
  /** 修改行：主键定位 + 修改的列值 */
  updates: { pkValues: string[]; changes: Record<string, string> }[];
  /** 删除行：主键定位 */
  deletes: { pkValues: string[] }[];
}

/** 发送给主进程的操作消息 */
export interface UiMessage {
  type: 'loadPage' | 'updateCell' | 'deleteRow' | 'addRow' | 'commit' | 'editCell';
  payload: {
    page?: number;
    pkValues?: unknown[];
    column?: string;
    newValue?: string;
    values?: Record<string, string>;
    commit?: CommitPayload;
    rowKey?: string;
    field?: string;
    value?: string;
  };
}
