import { useEffect, useState } from 'react';
import { App, Button, Card, Empty, Input, Segmented, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/PageHeader';
import {
  listPublishRequests,
  approvePublishRequest,
  rejectPublishRequest,
  type PublishRequestDTO,
  type PublishStatus,
} from '@/api/publishRequests';

const STATUSES: PublishStatus[] = ['pending', 'approved', 'rejected'];

const statusColor: Record<PublishStatus, string> = {
  pending: 'gold',
  approved: 'green',
  rejected: 'red',
};

export function ModelPublishRequestsPage() {
  const { message, modal } = App.useApp();
  const nav = useNavigate();
  const [status, setStatus] = useState<PublishStatus>('pending');
  const [items, setItems] = useState<PublishRequestDTO[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = (st: PublishStatus = status) => {
    setLoading(true);
    listPublishRequests({ status: st })
      .then(setItems)
      .catch(err => message.error((err as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const openReviewModal = (
    req: PublishRequestDTO,
    action: 'approve' | 'reject',
  ) => {
    let note = '';
    modal.confirm({
      title: action === 'approve' ? `Approve ${req.privateName}?` : `Reject ${req.privateName}?`,
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          {action === 'approve' ? (
            <Typography.Paragraph>
              The model metadata from <code>{req.privateNamespace}/{req.privateName}</code> will be
              copied into the public catalog as <strong>{req.targetName}</strong>.
            </Typography.Paragraph>
          ) : (
            <Typography.Paragraph>
              Reject this request — please leave a short note for the requester explaining why.
            </Typography.Paragraph>
          )}
          <Input.TextArea
            rows={3}
            onChange={e => {
              note = e.target.value;
            }}
            placeholder="Reviewer note (optional)"
          />
        </Space>
      ),
      okText: action === 'approve' ? 'Approve' : 'Reject',
      okButtonProps: { danger: action === 'reject' },
      onOk: async () => {
        try {
          if (action === 'approve') {
            await approvePublishRequest(req.id, { reviewerNote: note });
            message.success(`Approved — created public model "${req.targetName}".`);
          } else {
            await rejectPublishRequest(req.id, { reviewerNote: note });
            message.success('Request rejected.');
          }
          refresh();
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  };

  return (
    <div className="knaic-page">
      <PageHeader
        title="Model publish requests"
        description="Review requests from namespace users to publish private models into the public Model Catalog."
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => refresh()}>
            Refresh
          </Button>
        }
      />
      <Segmented
        options={STATUSES.map(s => ({ label: s.charAt(0).toUpperCase() + s.slice(1), value: s }))}
        value={status}
        onChange={v => setStatus(v as PublishStatus)}
        style={{ marginBottom: 12 }}
      />
      {loading ? (
        <Spin />
      ) : items.length === 0 ? (
        <Empty description={`No ${status} requests.`} />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {items.map(r => (
            <Card key={r.id} size="small" hoverable>
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                <Space wrap size={[8, 4]}>
                  <Tag color={statusColor[r.status]}>{r.status}</Tag>
                  <Typography.Text strong>{r.privateName}</Typography.Text>
                  <Tooltip title="Namespace of the private source">
                    <Tag>{r.privateNamespace}</Tag>
                  </Tooltip>
                  <span style={{ opacity: 0.7 }}>→</span>
                  <Typography.Text code>{r.targetName}</Typography.Text>
                  <Typography.Text type="secondary">requested by {r.requestedBy}</Typography.Text>
                </Space>
                <Typography.Text type="secondary" code style={{ fontSize: 12 }}>
                  {r.privateUri}
                </Typography.Text>
                {r.note && (
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    <strong>Note:</strong> {r.note}
                  </Typography.Paragraph>
                )}
                {r.reviewerNote && (
                  <Typography.Paragraph style={{ marginBottom: 0 }}>
                    <strong>Reviewer:</strong> {r.reviewerNote} <em>— {r.reviewedBy}</em>
                  </Typography.Paragraph>
                )}
                {r.status === 'approved' && r.catalogModelId && (
                  <div>
                    <Button
                      size="small"
                      type="link"
                      onClick={() => nav(`/models/public/${r.catalogModelId}`)}
                    >
                      Open catalog entry →
                    </Button>
                  </div>
                )}
                {r.status === 'pending' && (
                  <Space>
                    <Button
                      type="primary"
                      icon={<CheckCircleOutlined />}
                      onClick={() => openReviewModal(r, 'approve')}
                    >
                      Approve
                    </Button>
                    <Button
                      danger
                      icon={<CloseCircleOutlined />}
                      onClick={() => openReviewModal(r, 'reject')}
                    >
                      Reject
                    </Button>
                  </Space>
                )}
              </Space>
            </Card>
          ))}
        </Space>
      )}
    </div>
  );
}
