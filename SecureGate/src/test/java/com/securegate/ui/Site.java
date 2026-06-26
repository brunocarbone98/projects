package com.securegate.ui;

import com.securegate.support.Config;

/**
 * Single source of truth for Shipping Hub web URLs. Builds absolute {@code /en} URLs from the
 * configured {@code webBaseUrl} (env {@code local}/{@code live}), so the Screenplay tasks never
 * hard-code a host. Reuses the project's {@link Config} loader — the same config the API side reads.
 */
public final class Site {

  private Site() {}

  /** Absolute URL for an {@code /en}-locale path, e.g. {@code Site.url("/tracking/PTY-...")}. */
  public static String url(String path) {
    return Config.get().webBaseUrl() + "/en" + path;
  }

  /** The seeded demo tracking code (shared with the API side). */
  public static String demoTrackingCode() {
    return Config.get().demoTrackingCode();
  }
}
