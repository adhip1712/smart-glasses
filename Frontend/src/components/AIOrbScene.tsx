import React, { useEffect, useRef } from "react"
import * as THREE from "three"

const AIOrbScene: React.FC = () => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 80)
    camera.position.set(0, 0, 5.2)
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.25
    host.appendChild(renderer.domElement)

    scene.add(new THREE.AmbientLight(0x9ccfff, 1.5))
    const cyan = new THREE.PointLight(0x63eaff, 42, 12); cyan.position.set(-2, 2, 3); scene.add(cyan)
    const violet = new THREE.PointLight(0xa58aff, 34, 10); violet.position.set(2, -1, 2); scene.add(violet)

    const nucleus = new THREE.Group()
    scene.add(nucleus)
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.66, 4),
      new THREE.MeshPhysicalMaterial({
        color: 0x7bdfff, metalness: 0.38, roughness: 0.2,
        transmission: 0.18, thickness: 0.7, clearcoat: 1,
        emissive: 0x174b83, emissiveIntensity: 0.45
      })
    )
    nucleus.add(core)
    const inner = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.43, 2),
      new THREE.MeshBasicMaterial({ color: 0xc7f6ff, wireframe: true, transparent: true, opacity: 0.22 })
    )
    nucleus.add(inner)

    const nodes: THREE.Mesh[] = []
    const nodePositions: THREE.Vector3[] = []
    const count = 18
    for (let i = 0; i < count; i++) {
      const phi = Math.acos(1 - 2 * (i + 0.5) / count)
      const theta = Math.PI * (1 + Math.sqrt(5)) * i
      const p = new THREE.Vector3(
        Math.cos(theta) * Math.sin(phi),
        Math.cos(phi),
        Math.sin(theta) * Math.sin(phi)
      ).multiplyScalar(1.02 + (i % 3) * 0.035)
      nodePositions.push(p)
      const node = new THREE.Mesh(
        new THREE.SphereGeometry(i % 4 === 0 ? 0.055 : 0.032, 16, 16),
        new THREE.MeshStandardMaterial({
          color: i % 3 === 0 ? 0xc0a5ff : 0x8cecff,
          emissive: i % 3 === 0 ? 0x6845bd : 0x258ca8,
          emissiveIntensity: 1.7, metalness: 0.35, roughness: 0.18
        })
      )
      node.position.copy(p); nucleus.add(node); nodes.push(node)
    }

    const linePositions: number[] = []
    nodePositions.forEach((p, i) => {
      const nearest = nodePositions
        .map((q, j) => ({ j, d: p.distanceTo(q) }))
        .filter(v => v.j > i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 2)
      nearest.forEach(({ j }) => {
        const q = nodePositions[j]
        linePositions.push(p.x, p.y, p.z, q.x, q.y, q.z)
      })
    })
    const networkGeometry = new THREE.BufferGeometry()
    networkGeometry.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3))
    const network = new THREE.LineSegments(
      networkGeometry,
      new THREE.LineBasicMaterial({ color: 0x82dcff, transparent: true, opacity: 0.48 })
    )
    nucleus.add(network)

    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(1.32, 0.012, 10, 140),
      new THREE.MeshBasicMaterial({ color: 0x8beaff, transparent: true, opacity: 0.42 })
    )
    halo.rotation.set(0.85, 0.3, 0.1); nucleus.add(halo)
    const halo2 = new THREE.Mesh(
      new THREE.TorusGeometry(1.48, 0.008, 8, 140),
      new THREE.MeshBasicMaterial({ color: 0xb19aff, transparent: true, opacity: 0.28 })
    )
    halo2.rotation.set(1.25, -0.5, 0.7); nucleus.add(halo2)

    const pulse = new THREE.Mesh(
      new THREE.SphereGeometry(0.085, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    )
    nucleus.add(pulse)

    let frame = 0
    let pointerX = 0, pointerY = 0, targetX = 0, targetY = 0
    const onPointer = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect()
      targetX = ((event.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 0.22
      targetY = ((event.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 0.16
    }
    const resize = () => {
      const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight)
      camera.aspect = w / h
      camera.position.z = w < 480 ? 5.8 : 5.2
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, false)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    window.addEventListener("pointermove", onPointer, { passive: true })
    resize()
    const animate = () => {
      frame = requestAnimationFrame(animate)
      const t = performance.now() * 0.001
      pointerX += (targetX - pointerX) * 0.035
      pointerY += (targetY - pointerY) * 0.035
      nucleus.rotation.y = t * 0.16 + pointerX
      nucleus.rotation.x = Math.sin(t * 0.22) * 0.08 + pointerY
      const beat = 1 + Math.sin(t * 1.8) * 0.025
      core.scale.setScalar(beat)
      inner.rotation.y = -t * 0.25
      inner.rotation.x = t * 0.12
      nodes.forEach((node, i) => {
        const p = nodePositions[i]
        node.scale.setScalar(0.86 + (Math.sin(t * 2.2 + i) + 1) * 0.22)
        node.position.copy(p).multiplyScalar(1 + Math.sin(t * 0.7 + i * 0.6) * 0.018)
      })
      halo.rotation.z = t * 0.12
      halo2.rotation.y = -t * 0.1
      pulse.position.set(Math.sin(t * 1.3) * 0.88, Math.cos(t * 1.3) * 0.42, 0.12)
      camera.position.x += (pointerX * 0.6 - camera.position.x) * 0.025
      camera.position.y += (-pointerY * 0.6 - camera.position.y) * 0.025
      camera.lookAt(0, 0, 0)
      renderer.render(scene, camera)
    }
    animate()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("pointermove", onPointer)
      scene.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
          object.geometry.dispose()
          const mats = Array.isArray(object.material) ? object.material : [object.material]
          mats.forEach(material => material.dispose())
        }
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])
  return <div ref={hostRef} className="vn-ai-3d-scene" aria-hidden="true" />
}
export default AIOrbScene
