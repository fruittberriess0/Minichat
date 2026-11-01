export function messageStatus(message, receipts = []) {
  if (message.__pending) return {label:"Отправляется…",symbol:"◷",state:"pending"};
  if (message.__failed) return {label:"Ожидает отправки",symbol:"↻",state:"failed"};
  const peers = receipts.filter(row => row.message_id === message.id && row.user_id !== message.sender_id);
  if (message.read_at || peers.some(row => row.read_at)) return {label:"Прочитано",symbol:"✓✓",state:"read"};
  if (peers.some(row => row.delivered_at)) return {label:"Доставлено",symbol:"✓✓",state:"delivered"};
  return {label:"Отправлено",symbol:"✓",state:"sent"};
}
