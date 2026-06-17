package com.securegate.ui;

import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.containsString;

import com.securegate.ui.pages.Header;
import com.securegate.ui.support.BaseUiIT;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.openqa.selenium.support.ui.ExpectedConditions;

/** Phase 3 — the es/en language switch through the web UI. */
@DisplayName("UI: language switch")
class LanguageSwitchUiIT extends BaseUiIT {

  @Test
  @DisplayName("the header toggle switches the locale to Spanish")
  void switchToSpanish() {
    open("/");
    new Header(driver).switchLanguage();
    wait.until(ExpectedConditions.urlContains("/es"));
    assertThat(driver.getCurrentUrl(), containsString("/es"));
  }
}
