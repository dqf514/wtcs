import { useEffect, useState } from 'react'

export interface Branding {
  version: number
  logo_url: string
  mark_url: string
  custom: { logo: boolean; mark: boolean }
}

/** 后端不可达时的兜底（frontend/public 内置图） */
export const DEFAULT_BRANDING: Branding = {
  version: 0,
  logo_url: '/logo.png',
  mark_url: '/logo-mark.png',
  custom: { logo: false, mark: false },
}

/**
 * 品牌标识（Logo）全局来源：后端 /api/branding 单点配置，全站所有展示位共用。
 * 登录页/候客大屏在鉴权前也可调用（接口公开）。自定义图标 Logo 会同步为浏览器 favicon。
 */
export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING)

  useEffect(() => {
    let alive = true
    fetch('/api/branding')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Branding) => {
        if (alive) setBranding(d)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 自定义图标 Logo 时同步替换页签 favicon
  useEffect(() => {
    if (!branding.custom.mark) return
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link && link.dataset.brandingApplied !== String(branding.version)) {
      link.href = branding.mark_url
      link.type = 'image/png'
      link.dataset.brandingApplied = String(branding.version)
    }
  }, [branding])

  return branding
}
