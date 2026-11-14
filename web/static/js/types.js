// @ts-check
/**
 * Shared JSDoc typedefs for the API contract (docs/API.md). No runtime code.
 *
 * @typedef {{ id: string, email: string, username: string, role: 'admin' | 'user', twofa_enabled: boolean, created_at?: string }} User
 *
 * @typedef {{ mode: 'none' | 'gradient' | 'image', gradient: string, url: string, showGrid: boolean }} WallpaperSettings
 * @typedef {{ clock: boolean, greeting: boolean, stats: boolean, search: boolean, statusChecks: boolean }} FeatureSettings
 * @typedef {{ provider: string, searxngUrl: string }} SearchSettings
 * @typedef {{
 *   theme: 'auto' | 'light' | 'dark', accent: string,
 *   userName: string, pageTitle: string, subtitle: string, defaultDomain: string,
 *   wallpaper: WallpaperSettings, features: FeatureSettings, search: SearchSettings
 * }} Settings
 *
 * @typedef {{ id: string, name: string, url: string, description: string, icon: string, category: string | null, check: boolean, created_at?: string }} Service
 * @typedef {{ id: string, name: string, url: string, color: string, created_at?: string }} Bookmark
 * @typedef {{ user: User, settings: Settings, services: Service[], bookmarks: Bookmark[] }} Bootstrap
 *
 * @typedef {{ state: 'up' | 'down' | 'unknown', http_status: number | null, latency_ms: number | null, checked_at: string | null }} ServiceStatus
 * @typedef {{ id: string, name: string, url: string, username: string, has_password: boolean }} BeszelInstance
 * @typedef {{ name: string, status: string, host: string, cpu: number | null, memory: number | null, disk: number | null, uptime_seconds: number | null }} BeszelSystem
 */

export {};
