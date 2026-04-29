import { Modal } from 'antd';

export function YamlViewer({
  open,
  onClose,
  title,
  yaml,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  yaml: string;
}) {
  return (
    <Modal open={open} onCancel={onClose} title={title} width={760} footer={null} destroyOnClose>
      <pre className="log-viewer" style={{ minHeight: 240 }}>
        {yaml}
      </pre>
    </Modal>
  );
}
