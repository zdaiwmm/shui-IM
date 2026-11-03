import { lookupFault } from '../server/faults.mjs';
import stages from '../src/lib/fault-stages.json' with { type:'json' };
const id = (process.argv[2] ?? '').trim().toUpperCase();
try {
  const record = lookupFault(process.env.DATA_DIR ?? '/app/data',id);
  if (record) console.log(JSON.stringify({...record, step: ({'upload.write':'服务器写入附件分片','send.store':'服务器保存消息'})[record.stage] ?? stages[record.stage], created_at:new Date(record.created_at).toISOString()},null,2));
  else { console.error('FAULT_NOT_FOUND'); process.exitCode=1; }
} catch { console.error('FAULT_LOOKUP_UNAVAILABLE_OR_INVALID_ID'); process.exitCode=2; }
