import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 页面级错误边界：任何页面/组件异常只降级为可恢复的错误面板，
 * 绝不允许整个 HMI 白屏（工业软件可用性底线）。点击重试或切换页面即可恢复。
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('[wtcs] 页面渲染异常', error, info)
  }

  render(): ReactNode {
    const { error } = this.state
    if (error) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-header">
            <div className="error-boundary-icon">!</div>
            <div>
              <h2 className="error-boundary-title">页面渲染异常</h2>
            </div>
          </div>
          <p className="error-boundary-desc">
            页面渲染时发生了未知错误，请尝试重试或刷新页面。如问题持续，请联系技术支持。
          </p>
          <div className="error-boundary-details">
            {error.message || String(error)}
          </div>
          <div className="error-boundary-actions">
            <button type="button" className="btn primary" onClick={() => this.setState({ error: null })}>
              重试
            </button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              刷新页面
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
