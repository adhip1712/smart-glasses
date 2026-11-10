import { useEffect, useRef } from 'react'
import * as THREE from 'three'

export default function ThreeScene() {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = host.current
    if (!root) return

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)
    camera.position.set(0, 0.25, 9.5)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.25
    renderer.setClearColor(0x000000, 0)
    root.appendChild(renderer.domElement)

    const group = new THREE.Group()
    scene.add(group)

    scene.add(new THREE.HemisphereLight(0xeafff5, 0x35564e, 2.1))
    const key = new THREE.DirectionalLight(0xffffff, 3.4)
    key.position.set(3, 5, 7)
    scene.add(key)
    const mintLight = new THREE.PointLight(0x66e0bd, 26, 12)
    mintLight.position.set(-3, 1.2, 3)
    scene.add(mintLight)
    const rimLight = new THREE.PointLight(0x7cb8ff, 16, 10)
    rimLight.position.set(3, -2, -2)
    scene.add(rimLight)

    const dark = new THREE.MeshPhysicalMaterial({ color: 0x173e38, metalness: 0.72, roughness: 0.22, clearcoat: 1 })
    const edge = new THREE.MeshStandardMaterial({ color: 0x3b9b81, metalness: 0.55, roughness: 0.24 })
    const lens = new THREE.MeshPhysicalMaterial({ color: 0x9dddc8, metalness: 0.12, roughness: 0.08, transmission: 0.38, transparent: true, opacity: 0.68, thickness: 0.4, clearcoat: 1 })
    const glassFrame = new THREE.Group()
    group.add(glassFrame)

    const roundedRect = (w: number, h: number, r: number) => {
      const shape = new THREE.Shape()
      shape.moveTo(-w/2+r, -h/2)
      shape.lineTo(w/2-r, -h/2)
      shape.quadraticCurveTo(w/2, -h/2, w/2, -h/2+r)
      shape.lineTo(w/2, h/2-r)
      shape.quadraticCurveTo(w/2, h/2, w/2-r, h/2)
      shape.lineTo(-w/2+r, h/2)
      shape.quadraticCurveTo(-w/2, h/2, -w/2, h/2-r)
      shape.lineTo(-w/2, -h/2+r)
      shape.quadraticCurveTo(-w/2, -h/2, -w/2+r, -h/2)
      return shape
    }
    const frameGeo = (w: number, h: number) => {
      const shape = roundedRect(w, h, 0.28)
      const hole = new THREE.Path()
      const inner = roundedRect(w - 0.2, h - 0.2, 0.21)
      hole.curves = inner.curves
      hole.currentPoint.copy(inner.currentPoint)
      shape.holes.push(hole)
      return new THREE.ExtrudeGeometry(shape, { depth: 0.16, bevelEnabled: true, bevelSegments: 5, steps: 1, bevelSize: 0.045, bevelThickness: 0.035, curveSegments: 20 })
    }
    const lensGeo = (w: number, h: number) => new THREE.ExtrudeGeometry(roundedRect(w, h, 0.23), {
      depth: 0.035, bevelEnabled: true, bevelSegments: 5, bevelSize: 0.025, bevelThickness: 0.018, curveSegments: 24
    })
    for (const x of [-1.04, 1.04]) {
      const frameMesh = new THREE.Mesh(frameGeo(1.72, 1.12), dark)
      frameMesh.position.set(x, 0, 0)
      glassFrame.add(frameMesh)
      const pane = new THREE.Mesh(lensGeo(1.48, 0.88), lens)
      pane.position.set(x, 0, 0.13)
      glassFrame.add(pane)
      const glint = new THREE.Mesh(
        new THREE.TorusGeometry(0.22, 0.012, 8, 48, Math.PI * 1.35),
        new THREE.MeshBasicMaterial({ color: 0xe5fff5, transparent: true, opacity: 0.72 })
      )
      glint.position.set(x - 0.28, 0.23, 0.205)
      glint.rotation.z = 0.4
      glassFrame.add(glint)
    }
    const bridgeCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.18, 0.18, 0.03),
      new THREE.Vector3(-0.1, 0.28, 0.18),
      new THREE.Vector3(0.1, 0.28, 0.18),
      new THREE.Vector3(0.18, 0.18, 0.03)
    ])
    glassFrame.add(new THREE.Mesh(new THREE.TubeGeometry(bridgeCurve, 32, 0.075, 12, false), edge))
    for (const side of [-1, 1]) {
      const armCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 1.88, 0.22, -0.02),
        new THREE.Vector3(side * 2.12, 0.2, -0.18),
        new THREE.Vector3(side * 2.28, 0.1, -0.58),
        new THREE.Vector3(side * 2.25, 0.02, -1.05),
        new THREE.Vector3(side * 2.08, -0.04, -1.24)
      ])
      const arm = new THREE.Mesh(new THREE.TubeGeometry(armCurve, 48, 0.075, 12, false), dark)
      glassFrame.add(arm)
      const hinge = new THREE.Mesh(new THREE.SphereGeometry(0.105, 20, 20), edge)
      hinge.position.set(side * 1.88, 0.2, 0)
      glassFrame.add(hinge)
    }    const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 24), new THREE.MeshStandardMaterial({ color: 0x5be1c0, emissive: 0x167d66, emissiveIntensity: 1.4, metalness: 0.3 }))
    sensor.position.set(0, -0.02, 0.22)
    glassFrame.add(sensor)

    const ringMat = new THREE.MeshBasicMaterial({ color: 0x5bbd9f, transparent: true, opacity: 0.38 })
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.3 + i * 0.34, 0.009, 8, 120), ringMat)
      ring.rotation.x = Math.PI * (0.35 + i * 0.08)
      ring.rotation.y = i * 0.5
      ring.position.z = -0.75 - i * 0.15
      group.add(ring)
    }

    const panelMat = new THREE.MeshPhysicalMaterial({ color: 0xf6fffa, metalness: 0.08, roughness: 0.22, transparent: true, opacity: 0.93, clearcoat: 0.8 })
    const panelEdge = new THREE.MeshStandardMaterial({ color: 0x75bda6, metalness: 0.35, roughness: 0.3 })
    const makePanel = (x: number, y: number, z: number, w: number, h: number) => {
      const panel = new THREE.Group()
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.11), panelMat)
      body.castShadow = true
      body.receiveShadow = true
      panel.add(body)
      const top = new THREE.Mesh(new THREE.BoxGeometry(w * 0.72, 0.035, 0.025), panelEdge)
      top.position.set(-w * 0.08, h * 0.29, 0.07)
      panel.add(top)
      for (let i = 0; i < 4; i++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(w * (0.23 + (i % 2) * 0.12), 0.045, 0.025), panelEdge)
        bar.position.set(-w * 0.24 + i * w * 0.15, -h * 0.25, 0.07)
        panel.add(bar)
      }
      panel.position.set(x, y, z)
      group.add(panel)
      return panel
    }
    const panelA = makePanel(-2.75, 1.25, -0.7, 1.45, 0.92)
    const panelB = makePanel(2.65, 0.82, -1.05, 1.35, 0.86)
    const panelC = makePanel(2.35, -1.35, -0.65, 1.5, 0.78)
    panelA.rotation.y = 0.28
    panelA.rotation.x = -0.12
    panelB.rotation.y = -0.32
    panelB.rotation.x = 0.1
    panelC.rotation.y = -0.24
    panelC.rotation.x = -0.08

    const orbGeo = new THREE.IcosahedronGeometry(0.18, 1)
    const orbMat = new THREE.MeshStandardMaterial({ color: 0x68d9b8, metalness: 0.55, roughness: 0.18, emissive: 0x174d40, emissiveIntensity: 0.45 })
    const orbs: THREE.Mesh[] = []
    for (let i = 0; i < 9; i++) {
      const orb = new THREE.Mesh(orbGeo, orbMat)
      const a = (i / 9) * Math.PI * 2
      orb.position.set(Math.cos(a) * 3.05, Math.sin(a) * 1.85, -0.2 + Math.sin(a * 2) * 0.3)
      orb.scale.setScalar(i % 3 === 0 ? 1 : 0.55)
      group.add(orb)
      orbs.push(orb)
    }

    const floor = new THREE.Mesh(new THREE.CircleGeometry(4.3, 80), new THREE.MeshBasicMaterial({ color: 0x9bcfba, transparent: true, opacity: 0.09 }))
    floor.rotation.x = -Math.PI / 2
    floor.position.set(0, -2.1, -0.4)
    group.add(floor)

    let targetX = 0
    let targetY = 0
    let frame = 0
    let width = 0
    let height = 0
    const resize = () => {
      const rect = root.getBoundingClientRect()
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.position.z = width < 520 ? 12 : width < 800 ? 10.5 : 9.5
      camera.updateProjectionMatrix()
    }
    const onPointerMove = (event: PointerEvent) => {
      const rect = root.getBoundingClientRect()
      targetY = ((event.clientX - rect.left) / rect.width - 0.5) * 0.5
      targetX = ((event.clientY - rect.top) / rect.height - 0.5) * 0.25
    }
    const onPointerLeave = () => { targetX = 0; targetY = 0 }
    root.addEventListener('pointermove', onPointerMove)
    root.addEventListener('pointerleave', onPointerLeave)
    const observer = new ResizeObserver(resize)
    observer.observe(root)
    resize()

    const clock = new THREE.Clock()
    const animate = () => {
      frame = requestAnimationFrame(animate)
      const t = clock.getElapsedTime()
      glassFrame.rotation.y += (targetY - glassFrame.rotation.y) * 0.035
      glassFrame.rotation.x += (-targetX - glassFrame.rotation.x) * 0.035
      glassFrame.position.y = Math.sin(t * 0.8) * 0.09
      group.rotation.y += (targetY * 0.12 - group.rotation.y) * 0.02
      group.rotation.x += (targetX * 0.1 - group.rotation.x) * 0.02
      panelA.position.y = 1.25 + Math.sin(t * 0.7) * 0.07
      panelB.position.y = 0.82 + Math.sin(t * 0.8 + 1) * 0.09
      panelC.position.y = -1.35 + Math.sin(t * 0.65 + 2) * 0.06
      orbs.forEach((orb, i) => {
        orb.rotation.x = t * 0.35 + i
        orb.rotation.y = t * 0.24 + i
      })
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerleave', onPointerLeave)
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose()
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
          materials.forEach((material) => material.dispose())
        }
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return <div ref={host} className="vn-three-scene" role="img" aria-label="Interactive 3D smart glasses and floating system interface" />
}
