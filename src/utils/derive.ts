import type { Node, Usage } from '../types'
import { bytes } from './format'

export function deriveUsage(node: Node): Usage {
  const d = node.dynamic
  const memUsed = d?.used_memory ?? 0
  const memTotal = d?.total_memory ?? 0
  const diskTotal = d?.total_space ?? 0
  const diskUsed = diskTotal && d?.available_space != null ? diskTotal - d.available_space : 0
  return {
    cpu: d?.cpu_usage,
    mem: memTotal ? (memUsed / memTotal) * 100 : undefined,
    memUsed,
    memTotal,
    disk: diskTotal ? (diskUsed / diskTotal) * 100 : undefined,
    diskUsed,
    diskTotal,
    netIn: d?.receive_speed,
    netOut: d?.transmit_speed,
    uptime: d?.uptime,
    ts: d?.timestamp,
  }
}

/**
 * 本期已用流量（展示用）：worker 账期基准 + 实时累计计数器动态求差，每 2s 随实时数据刷新。
 * base 取自 worker 写入的 metadata_traffic_period_base_upload/_download（账期起点快照）；
 * 无 base（非 quota 或 worker 未跑）时回退实时累计。upload=上行(transmitted)，download=下行(received)。
 * 仅为展示、不计费；worker 仍是计费权威。
 */
export function trafficUsed(node: Node): { upload: number; download: number } {
  const liveUpload = node.dynamic?.total_transmitted ?? 0
  const liveDownload = node.dynamic?.total_received ?? 0
  const baseUpload = node.meta?.baseUpload
  const baseDownload = node.meta?.baseDownload
  return {
    upload: baseUpload != null ? Math.max(0, liveUpload - baseUpload) : liveUpload,
    download: baseDownload != null ? Math.max(0, liveDownload - baseDownload) : liveDownload,
  }
}

const GB = 1073741824

/** 按节点计量口径聚合分方向用量（与 worker 的 aggregateUsed 口径一致）。 */
function aggregateByMode(
  upload: number,
  download: number,
  mode: Node['meta']['countMode'],
): number {
  switch (mode) {
    case 'upload':
      return upload
    case 'download':
      return download
    case 'max':
      return Math.max(upload, download)
    case 'sum':
    default:
      return upload + download
  }
}

/**
 * 流量费用（payg 展示用）：超出免费额度的用量 × 单价（美元）；非 payg 返回 0。
 * 与 trafficBar 同口径，仅为展示、不计费（worker 仍是计费权威）。
 */
export function trafficCost(node: Node): number {
  const meta = node.meta
  if (!meta || meta.billingMode !== 'payg') return 0
  const { upload, download } = trafficUsed(node)
  const used = aggregateByMode(upload, download, meta.countMode)
  const price = meta.trafficPrice ?? 0
  const include = meta.trafficInclude ?? 0
  return Math.max(0, used / GB - include) * price
}

/**
 * 流量进度条数据（展示用），返回 {percent, hint, text?}：
 * - quota：percent = 计量口径聚合用量 / 限额；不返回 text（组件显示默认百分比）。
 * - payg：percent = 已用 / 免费额度（无免费额度则 0）；text = `$` + 超出免费额度部分 × 单价。
 * 无流量配置返回 null。
 */
export function trafficBar(
  node: Node,
): { percent: number; text?: string; hint: string } | null {
  const meta = node.meta
  if (!meta) return null
  const { upload, download } = trafficUsed(node)
  const used = aggregateByMode(upload, download, meta.countMode)

  if (meta.billingMode === 'payg') {
    const include = meta.trafficInclude ?? 0
    const usedGb = used / GB
    const percent = include > 0 ? Math.min((usedGb / include) * 100, 100) : 0
    return {
      percent,
      text: `$${trafficCost(node).toFixed(2)}`,
      hint: include > 0 ? `${bytes(used)} / 含 ${bytes(include * GB)}` : bytes(used),
    }
  }

  const limitGb = meta.trafficLimitGb
  if (limitGb && limitGb > 0) {
    const limit = limitGb * GB
    return {
      percent: (used / limit) * 100,
      hint: `${bytes(used)} / ${bytes(limit)}`,
    }
  }
  return null
}

export function displayName(node: Node) {
  return node.meta?.name || node.static?.system?.system_host_name || node.uuid.slice(0, 8)
}

export function cpuLabel(node: Node) {
  const cpu = node.static?.cpu
  const cores = cpu?.physical_cores ?? cpu?.per_core?.length
  const brand = cpu?.brand || cpu?.per_core?.[0]?.brand || ''
  const parts: string[] = []
  if (cores) parts.push(`${cores} 核`)
  if (brand) parts.push(shortenCpuBrand(brand))
  return parts.join(' · ')
}

/** 精简 OS 上报的 CPU 品牌串：去掉商标/频率/“Processor”等噪声，只留品牌与型号。 */
function shortenCpuBrand(brand: string): string {
  return brand
    .replace(/\(R\)/g, '')
    .replace(/\(TM\)/g, '')
    .replace(/\s*CPU\s*@\s*[\d.]+\s*GHz.*$/i, '')
    .replace(/\s*\d+-Core\s+Processor.*$/i, '')
    .replace(/\s+Processor\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function osLabel(node: Node) {
  const s = node.static?.system
  if (!s) return ''
  if (s.system_os_long_version) return s.system_os_long_version
  return [s.system_name, s.system_os_version || s.system_version].filter(Boolean).join(' ')
}

const LOGO_BASE = `${import.meta.env.BASE_URL}linux-logo-icon/`

const DISTROS = [
  { file: 'archlinux.svg', match: ['arch'] },
  { file: 'manjaro.svg', match: ['manjaro'] },
  { file: 'kali.svg', match: ['kali'] },
  { file: 'ubuntu.svg', match: ['ubuntu'] },
  { file: 'mint.svg', match: ['mint'] },
  { file: 'debian.svg', match: ['debian'] },
  { file: 'alpinelinux-icon.svg', match: ['alpine'] },
  { file: 'fedora.svg', match: ['fedora'] },
  { file: 'rocky.svg', match: ['rocky'] },
  { file: 'oracle.svg', match: ['oracle'] },
  { file: 'redhat.svg', match: ['red hat', 'redhat', 'rhel', 'almalinux'] },
  { file: 'centos.svg', match: ['centos'] },
  { file: 'gentoo.svg', match: ['gentoo'] },
  { file: 'nixos.svg', match: ['nix'] },
  { file: 'zorin.svg', match: ['zorin'] },
  { file: 'freebsd.svg', match: ['freebsd', 'bsd'] },
  { file: 'windows.svg', match: ['windows', 'microsoft'] },
]

export function distroLogo(node: Node) {
  const s = node.static?.system
  const hay = [s?.distribution_id, s?.system_name, s?.system_os_version, s?.system_version]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .trim()
  if (!hay) return ''
  for (const { file, match } of DISTROS) {
    if (match.some(k => hay.includes(k))) return `${LOGO_BASE}${file}`
  }
  return `${LOGO_BASE}linux.svg`
}

const VIRT_LABELS: Record<string, string> = {
  kvm: 'KVM',
  lxc: 'LXC',
  openvz: 'OpenVZ',
  vmware: 'VMware',
  hyperv: 'Hyper-V',
  'hyper-v': 'Hyper-V',
  xen: 'Xen',
  docker: 'Docker',
  wsl: 'WSL',
  dedicated: '独服',
}

function normalizeVirt(raw: string) {
  const key = raw.toLowerCase().trim()
  if (!key || key === 'none') return ''
  return VIRT_LABELS[key] || raw
}

export function virtLabel(node: Node) {
  const fromKv = node.meta?.virtualization
  if (fromKv) {
    const v = normalizeVirt(String(fromKv))
    if (v) return v
  }
  const fromApi = node.static?.system?.virtualization
  if (fromApi) {
    const v = normalizeVirt(String(fromApi))
    if (v) return v
  }
  return detectVirt(node)
}

function detectVirt(node: Node) {
  const s = node.static?.system
  const cpu = node.static?.cpu
  const kernel = (s?.system_kernel_version || s?.system_kernel || '').toLowerCase()
  const brand = (cpu?.brand || cpu?.per_core?.[0]?.brand || '').toLowerCase()

  if (kernel.includes('microsoft') || kernel.includes('wsl')) return 'WSL'
  if (kernel.includes('pve')) return 'Proxmox'
  if (brand.includes('hyper-v') || brand.includes('microsoft hyper')) return 'Hyper-V'
  if (brand.includes('vmware')) return 'VMware'
  if (brand.includes('xen')) return 'Xen'
  if (brand.includes('kvm') || brand.includes('qemu')) return 'KVM'
  if (/-aws|-azure|-gcp|-oracle/.test(kernel)) return 'KVM'
  return ''
}
