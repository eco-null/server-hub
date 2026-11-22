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
 * @typedef {{ user: User, settings: Settings, services: Service[], bookmarks: Bookmark[], layout?: import('./lib/grid.js').Layout, docker?: { enabled: boolean } }} Bootstrap
 *
 * @typedef {{ state: 'up' | 'down' | 'unknown', http_status: number | null, latency_ms: number | null, checked_at: string | null }} ServiceStatus
 * @typedef {'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead' | 'removing'} ContainerState
 * @typedef {{ name: string, image: string, state: ContainerState, status: string, health: 'healthy' | 'unhealthy' | 'starting' | null }} DockerContainer
 * @typedef {{ id: string, name: string, url: string, description: string, icon: string, category: string | null, check: boolean, container: DockerContainer }} DiscoveredService
 * @typedef {{ enabled: boolean, available: boolean, error: string | null, stale?: boolean, updated_at?: string | null, services: DiscoveredService[], skipped?: Array<{ container: string, reason: string }>, warnings?: Array<{ container: string, reason: string }> }} DockerResponse
 * @typedef {{ private: number, public: number, protocol: 'tcp' | 'udp' }} DockerPort
 * @typedef {{ container: { name: string, image: string, state: string }, ports: DockerPort[], suggested: { name: string, url: string | null, icon: string, category: string | null } }} DockerSuggestion
 * @typedef {{ available: boolean, error: string | null, suggestions: DockerSuggestion[] }} DockerSuggestions
 * @typedef {{ id: string, name: string, url: string, username: string, has_password: boolean }} BeszelInstance
 * @typedef {{ name: string, status: string, host: string, cpu: number | null, memory: number | null, disk: number | null, uptime_seconds: number | null }} BeszelSystem
 */

export {};
