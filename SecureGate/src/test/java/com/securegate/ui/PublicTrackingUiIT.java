package com.securegate.ui;

import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.greaterThan;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.securegate.support.Config;
import com.securegate.ui.pages.LandingPage;
import com.securegate.ui.pages.TrackingResultPage;
import com.securegate.ui.support.BaseUiIT;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Phase 3 — the public tracking journey through the web UI. */
@DisplayName("UI: public parcel tracking")
class PublicTrackingUiIT extends BaseUiIT {

  @Test
  @DisplayName("a visitor tracks the demo parcel from the landing page")
  void trackFromLanding() {
    String code = Config.get().demoTrackingCode();
    open("/");
    TrackingResultPage result = new LandingPage(driver).trackByCode(code);
    assertThat(driver.getCurrentUrl(), containsString("/tracking/" + code));
    assertThat(result.trackingCode(), equalTo(code));
    assertThat(result.eventCount(), greaterThan(0));
  }

  @Test
  @DisplayName("an unknown code shows the not-found view")
  void unknownCodeShowsNotFound() {
    open("/tracking/PTY-2026-987654-1");
    assertTrue(new TrackingResultPage(driver).isNotFound());
  }
}
