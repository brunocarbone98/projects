package com.securegate.ui;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.securegate.ui.pages.QuotePage;
import com.securegate.ui.support.BaseUiIT;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Phase 3 — the quote calculator journey through the web UI. */
@DisplayName("UI: quote calculator")
class QuoteUiIT extends BaseUiIT {

  @Test
  @DisplayName("calculating a quote shows a price")
  void calculateShowsPrice() {
    open("/quote");
    QuotePage quote = new QuotePage(driver);
    quote.calculate();
    assertTrue(quote.showsPrice(), "the quote result should show a $ price");
  }
}
