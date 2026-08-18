import React from 'react';
import { Button, Form, Input, Modal, Space } from 'antd';
import { postMessage } from '../../vscodeBridge';
import { ColumnDef } from './types';

interface Props {
  columns: ColumnDef[];
  page: number;
  onClose: () => void;
  onAdded: () => void;
}

/** 新增行 Modal（auto_increment 列自动生成，不展示） */
export function AddRowModal({ columns, page, onClose, onAdded }: Props): React.JSX.Element {
  const [form] = Form.useForm();
  const insertable = columns.filter((c) => !/auto_increment/i.test(c.extra));

  const submit = async () => {
    const values = await form.validateFields();
    postMessage({ type: 'addRow', payload: { values, page } });
    onClose();
    onAdded();
  };

  return (
    <Modal
      open
      title="新增行（auto_increment 列自动生成）"
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" onClick={submit}>提交插入</Button>
        </Space>
      }
      width={720}
    >
      <Form form={form} layout="vertical">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
          {insertable.map((c) => (
            <Form.Item
              key={c.field}
              name={c.field}
              label={c.field + (c.nullable ? '' : ' *')}
              rules={c.nullable ? [] : [{ required: true, message: `请输入 ${c.field}` }]}
              style={{ marginBottom: 8 }}
            >
              <Input placeholder={c.type} style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </Form.Item>
          ))}
        </div>
      </Form>
    </Modal>
  );
}
