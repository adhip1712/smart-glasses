import { useEffect, useState } from 'react'
import type { Tab } from '../App'
import AIOrbScene from './AIOrbScene'

const activities = [
  { time: '14:23:41', text: 'Scene analyzed — 7 objects detected', type: 'Vision', mark: '◈' },
  { time: '14:21:09', text: 'Voice command: Take photo', type: 'Voice', mark: '⌁' },
  { time: '14:18:55', text: 'AI query: Navigation to Lab B-7', type: 'Assistant', mark: '✳' },
  { time: '14:15:33', text: 'Object recognized: Circuit board (98.4%)', type: 'Vision', mark: '◈' },
]
const statuses = [
  { label: 'AI engine', value: 'Online', note: 'Assistant ready', active: true, icon: '✳' },
  { label: 'Camera', value: 'Active', note: 'Vision system', active: true, icon: '▣' },
  { label: 'Microphone', value: 'Ready', note: 'Voice input', active: true, icon: '⌁' },
  { label: 'Speaker', value: 'Idle', note: 'Audio output', active: false, icon: '◖' },
  { label: 'Bluetooth', value: 'Paired', note: 'Device link', active: true, icon: '⌘' },
  { label: 'GPS', value: 'Locked', note: 'Location service', active: true, icon: '◎' },
]
const shortcuts: { label: string; detail: string; tab: Tab; mark: string }[] = [
  { label: 'AI assistant', detail: 'Ask, dictate and get things done', tab: 'ai', mark: '✳' },
  { label: 'Vision', detail: 'Camera, recognition and scene analysis', tab: 'vision', mark: '◈' },
  { label: 'Music', detail: 'Your connected listening space', tab: 'music', mark: '♫' },
  { label: 'Navigation', detail: 'Routes, directions and places', tab: 'nav', mark: '↗' },
]

export default function Dashboard({ setActiveTab }: { setActiveTab: (t: Tab) => void }) {
  const [time, setTime] = useState(new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setTime(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="vn-dashboard vn-mint-dashboard">
      <section className="vn-dashboard-hero">
        <div className="vn-hero-copy">
          <div className="vn-eyebrow"><span /> YOUR PERSONAL INTERFACE</div>
          <h1>Everything connected.<br /><em>One clear view.</em></h1>
          <p>Welcome to your Visionary Nexus workspace. Your smart-glasses systems, tools and activity in one place.</p>
          <button className="vn-hero-cta" onClick={() => setActiveTab('vision')}>Explore vision <span>↗</span></button>
        </div>
        <div className="vn-hero-art vn-nexus-ai-art" aria-label="Nexus AI visual">
          <AIOrbScene />
        </div>
        <div className="vn-hero-date"><strong>{time.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}</strong><span>{time.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</span></div>
      </section>

      <section className="vn-dashboard-section">
        <div className="vn-section-heading">
          <div><span className="vn-eyebrow">AT A GLANCE</span><h2>System overview</h2></div>
          <span className="vn-section-note"><i /> LIVE STATUS</span>
        </div>
        <div className="vn-status-grid">
          {statuses.map((item) => (
            <article className="vn-status-card" key={item.label}>
              <div className="vn-status-icon">{item.icon}</div>
              <div className="vn-status-info">
                <span className="vn-status-label">{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.note}</small>
              </div>
              <span className={item.active ? 'vn-status-indicator is-active' : 'vn-status-indicator'} />
            </article>
          ))}
        </div>
      </section>

      <section className="vn-dashboard-lower">
        <article className="vn-module-panel">
          <div className="vn-section-heading">
            <div><span className="vn-eyebrow">YOUR TOOLS</span><h2>Quick access</h2></div>
            <span className="vn-section-note">OPEN A MODULE</span>
          </div>
          <div className="vn-shortcuts-grid">
            {shortcuts.map((item) => (
              <button className="vn-shortcut-card" key={item.tab} onClick={() => setActiveTab(item.tab)}>
                <span className="vn-shortcut-mark">{item.mark}</span>
                <span className="vn-shortcut-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
                <span className="vn-shortcut-arrow">↗</span>
              </button>
            ))}
          </div>
          <button className="vn-device-link" onClick={() => setActiveTab('device')}>
            <span className="vn-device-link-icon">⌘</span><span><b>Manage connected devices</b><small>View pairing and device settings</small></span><span className="vn-device-link-arrow">→</span>
          </button>
        </article>

        <article className="vn-activity-panel">
          <div className="vn-section-heading">
            <div><span className="vn-eyebrow">WHAT'S HAPPENING</span><h2>Recent activity</h2></div>
            <span className="vn-activity-live"><i /> LIVE</span>
          </div>
          <div className="vn-activity-list">
            {activities.map((activity) => (
              <div className="vn-activity-row" key={activity.time}>
                <span className="vn-activity-icon">{activity.mark}</span>
                <div className="vn-activity-copy"><strong>{activity.text}</strong><span>{activity.type}</span></div>
                <time>{activity.time.slice(0, 5)}</time>
              </div>
            ))}
          </div>
          <div className="vn-activity-footer">Your workspace activity appears here</div>
        </article>
      </section>
    </div>
  )
}
