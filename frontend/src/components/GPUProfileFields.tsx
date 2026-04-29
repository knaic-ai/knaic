import { Form, Select, InputNumber, Space, Tag } from 'antd';
import { useGPUProfiles, type GPUProfile } from '@/data/gpuProfiles';

interface Props {
  profileName?: string;
  valuesName?: string;
}

const kindColor: Record<GPUProfile['kind'], string> = {
  hami: 'geekblue',
  nvidia: 'green',
  npu: 'volcano',
  custom: 'purple',
};

export function GPUProfileFields({ profileName = 'gpuProfileId', valuesName = 'gpuValues' }: Props) {
  const profiles = useGPUProfiles();
  const form = Form.useFormInstance();
  const currentId = Form.useWatch(profileName, form) as string | undefined;
  const current = profiles.find(p => p.id === currentId);

  return (
    <>
      <Form.Item name={profileName} label="Accelerator type">
        <Select
          allowClear
          placeholder="CPU only (no accelerator)"
          options={profiles.map(p => ({
            value: p.id,
            label: (
              <Space>
                <Tag color={kindColor[p.kind]}>{p.kind}</Tag>
                <span>{p.name}</span>
              </Space>
            ),
          }))}
          onChange={id => {
            const p = profiles.find(x => x.id === id);
            const values: Record<string, number> = {};
            for (const f of p?.fields ?? []) values[f.key] = Number(f.defaultValue);
            form.setFieldValue(valuesName, values);
          }}
        />
      </Form.Item>
      {current && (
        <Space wrap size={8} style={{ marginBottom: 12 }}>
          {current.fields.map(f => (
            <Form.Item
              key={f.key}
              name={[valuesName, f.key]}
              label={
                <span>
                  {f.label}
                  {f.unit && <span className="knaic-sub"> ({f.unit})</span>}
                  <div className="knaic-sub mono" style={{ fontSize: 11 }}>{f.key}</div>
                </span>
              }
              initialValue={f.defaultValue}
              style={{ minWidth: 160 }}
            >
              <InputNumber min={f.min} max={f.max} step={f.step ?? 1} style={{ width: '100%' }} />
            </Form.Item>
          ))}
        </Space>
      )}
    </>
  );
}
