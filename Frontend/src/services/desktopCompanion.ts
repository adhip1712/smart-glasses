const BASE = "http://127.0.0.1:8765"

export type DesktopActionResult = {
  success: boolean
  app?: string
  kind?: string
  error?: string
  needs_connection?: boolean
  scheduled_for?: string
  note?: string
  task_scheduler_fallback?: boolean
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error || "Windows companion request failed")
  return data as T
}

export async function desktopCompanionAvailable(): Promise<boolean> {
  try {
    const result = await request<{ success: boolean }>("/health")
    return result.success === true
  } catch {
    return false
  }
}

export async function discoverDesktopApps(): Promise<Array<{ name: string; kind: string }>> {
  const result = await request<{ success: boolean; apps: Array<{ name: string; kind: string }> }>("/apps")
  return result.apps || []
}

export async function launchDesktopApp(app: string): Promise<DesktopActionResult> {
  return request<DesktopActionResult>("/launch", { app })
}

export async function openDesktopUrl(url: string): Promise<DesktopActionResult> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 1800)
  try {
    const response = await fetch(BASE + "/open-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      cache: "no-store",
      signal: controller.signal,
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || "Windows companion could not open the website")
    return data as DesktopActionResult
  } finally {
    window.clearTimeout(timeout)
  }
}

export type DesktopWindow = { window_id: string; title: string; process_id: number }
export type DesktopControl = {
  name: string
  control_type: string
  automation_id: string
  control_id?: number
  class_name?: string
  framework_id?: string
  enabled: boolean
  rectangle: { left: number; top: number; right: number; bottom: number }
}
export type DesktopInspection = { success: boolean; window_id: string; title: string; controls: DesktopControl[] }

export async function discoverDesktopWindows(): Promise<DesktopWindow[]> {
  const result = await request<{ success: boolean; windows: DesktopWindow[] }>("/windows")
  return result.windows || []
}
export async function inspectDesktopWindow(window_id: string): Promise<DesktopInspection> {
  return request<DesktopInspection>("/ui/inspect", { window_id })
}
export async function performDesktopAction(input: {
  window_id: string; action: "click" | "type_text" | "press_key"
  control_name?: string; automation_id?: string; control_type?: string; text?: string; key?: string; confirmed?: boolean
}): Promise<{ success: boolean; verified?: boolean; requires_confirmation?: boolean; message?: string }> {
  return request<{ success: boolean; verified?: boolean; requires_confirmation?: boolean; message?: string }>("/ui/action", input)
}

export type DesktopTaskPlan = {
  success: boolean
  task?: string
  app?: string
  ready?: boolean
  missing?: string[]
  field?: "text" | "filename" | "directory"
  questions?: string[]
  filename?: string
  directory?: string
  target?: string
  overwrite_required?: boolean
  steps?: Array<{ action: string; target?: string; app?: string }>
  error?: string
}
export async function planDesktopTask(input: {
  task: "save_text" | "launch_app"; command?: string; text?: string
  filename?: string; directory?: string; path?: string; destination_path?: string; app?: string
}): Promise<DesktopTaskPlan> {
  return request<DesktopTaskPlan>("/task/plan", input)
}
export async function executeDesktopTask(input: {
  task: "save_text" | "launch_app"; command?: string; text?: string
  filename?: string; directory?: string; app?: string; confirmed_overwrite?: boolean
}): Promise<{ success: boolean; path?: string; verified?: boolean; opened_in_notepad?: boolean
  requires_confirmation?: boolean; target?: string; message?: string; error?: string
  app?: string; opened_in_app?: boolean }> {
  return request<{ success: boolean; path?: string; verified?: boolean; opened_in_notepad?: boolean
    requires_confirmation?: boolean; target?: string; message?: string; error?: string; app?: string; opened_in_app?: boolean }>("/task/execute", input)
}
export async function captureDesktopWindow(window_id: string): Promise<{
  success: boolean; title: string; mime_type: string; image_base64: string; width: number; height: number
}> {
  return request("/ui/screenshot", { window_id })
}
