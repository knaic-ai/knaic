import { Modal, Input } from 'antd';

interface Props {
  open: boolean;
  title: string;
  value: string;
  saving?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}

export function YamlEditor({ open, title, value, saving, onChange, onSave, onClose }: Props) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onSave}
      confirmLoading={saving}
      title={title}
      width={860}
      okText="Save"
      destroyOnClose
    >
      <Input.TextArea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={24}
        spellCheck={false}
        className="mono"
        style={{ fontSize: 12, lineHeight: 1.45 }}
      />
    </Modal>
  );
}
