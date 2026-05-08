import { CopyOutlined } from '@ant-design/icons';
import { App, Button, Modal, Space } from 'antd';

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
  const { message } = App.useApp();
  const copyYaml = async () => {
    try {
      await navigator.clipboard.writeText(yaml);
      message.success('YAML copied');
    } catch {
      message.error('Copy failed');
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={
        <Space>
          <span>{title}</span>
          <Button size="small" icon={<CopyOutlined />} onClick={copyYaml} disabled={!yaml}>
            Copy
          </Button>
        </Space>
      }
      width={760}
      footer={null}
      destroyOnClose
    >
      <pre className="log-viewer" style={{ minHeight: 240 }}>
        {yaml}
      </pre>
    </Modal>
  );
}
