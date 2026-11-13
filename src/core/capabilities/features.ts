import type { ProxyNode } from '../ir/index.ts';
import type { NodeFeature } from './index.ts';

/** 从节点实际用到的字段反推所需能力；没有的字段不产生判定，避免误降级。 */
export function requiredFeatures(node: ProxyNode): readonly NodeFeature[] {
  const options = node.options;
  if (options === undefined) return [];
  const features: NodeFeature[] = [];
  if (options.tls === true) features.push('tls');
  if (options.sni !== undefined) features.push('sni');
  if (options.transport !== undefined) features.push('transport');
  if (options.path !== undefined) features.push('path');
  if (options.host !== undefined) features.push('host');
  if (options.flow !== undefined) features.push('flow');
  if (options.alterId !== undefined) features.push('alterId');
  if (options.cipher !== undefined) features.push('cipher');
  if (options.udp !== undefined) features.push('udp');
  if (options.plugin !== undefined) {
    // shadow-tls 的字段名与 obfs / v2ray-plugin 完全不同构（host / password / version），
    // 混用同一个特性会让「支持 obfs 的客户端」被误判成能写 shadow-tls。
    features.push(options.plugin === 'shadow-tls' ? 'shadowTls' : 'plugin');
  }
  if (options.reality !== undefined) features.push('reality');
  if (options.obfs !== undefined) features.push('obfs');
  if (options.alpn !== undefined) features.push('alpn');
  if (options.insecure === true) features.push('insecure');
  if (options.fingerprint !== undefined) features.push('fingerprint');
  if (options.bandwidth !== undefined) features.push('bandwidth');
  if (options.ports !== undefined) features.push('ports');
  if (options.congestionControl !== undefined) features.push('congestion');
  if (options.udpRelayMode !== undefined) features.push('udpRelayMode');
  if (options.version !== undefined) features.push('version');
  if (options.idleSessionTimeout !== undefined) features.push('idleSession');
  return features;
}
