#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopPlatform {
  Windows,
  Macos,
  Linux,
  Unknown,
}

impl DesktopPlatform {
  pub fn current() -> Self {
    if cfg!(target_os = "windows") {
      Self::Windows
    } else if cfg!(target_os = "macos") {
      Self::Macos
    } else if cfg!(target_os = "linux") {
      Self::Linux
    } else {
      Self::Unknown
    }
  }

  pub fn as_str(self) -> &'static str {
    match self {
      Self::Windows => "windows",
      Self::Macos => "macos",
      Self::Linux => "linux",
      Self::Unknown => "unknown",
    }
  }
}

#[derive(Debug, Clone, Copy)]
pub struct WindowMetrics {
  pub width: f64,
  pub height: f64,
  pub min_width: f64,
  pub min_height: f64,
}

pub fn current_platform() -> DesktopPlatform {
  DesktopPlatform::current()
}

pub fn main_window_metrics() -> WindowMetrics {
  match current_platform() {
    DesktopPlatform::Macos => WindowMetrics {
      width: 980.0,
      height: 760.0,
      min_width: 900.0,
      min_height: 640.0,
    },
    DesktopPlatform::Linux => WindowMetrics {
      width: 1024.0,
      height: 780.0,
      min_width: 960.0,
      min_height: 680.0,
    },
    DesktopPlatform::Windows | DesktopPlatform::Unknown => WindowMetrics {
      width: 960.0,
      height: 760.0,
      min_width: 940.0,
      min_height: 620.0,
    },
  }
}

pub fn settings_window_metrics() -> WindowMetrics {
  match current_platform() {
    DesktopPlatform::Macos => WindowMetrics {
      width: 780.0,
      height: 640.0,
      min_width: 700.0,
      min_height: 580.0,
    },
    DesktopPlatform::Linux => WindowMetrics {
      width: 820.0,
      height: 680.0,
      min_width: 740.0,
      min_height: 620.0,
    },
    DesktopPlatform::Windows | DesktopPlatform::Unknown => WindowMetrics {
      width: 760.0,
      height: 620.0,
      min_width: 680.0,
      min_height: 560.0,
    },
  }
}

pub fn float_window_metrics() -> WindowMetrics {
  match current_platform() {
    DesktopPlatform::Macos => WindowMetrics {
      width: 236.0,
      height: 206.0,
      min_width: 236.0,
      min_height: 206.0,
    },
    DesktopPlatform::Linux => WindowMetrics {
      width: 244.0,
      height: 214.0,
      min_width: 244.0,
      min_height: 214.0,
    },
    DesktopPlatform::Windows | DesktopPlatform::Unknown => WindowMetrics {
      width: 230.0,
      height: 200.0,
      min_width: 230.0,
      min_height: 200.0,
    },
  }
}
