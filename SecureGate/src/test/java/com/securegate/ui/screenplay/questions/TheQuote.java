package com.securegate.ui.screenplay.questions;

import com.securegate.ui.screenplay.ui.QuotePage;
import java.util.Objects;
import net.serenitybdd.core.pages.WebElementFacade;
import net.serenitybdd.screenplay.Question;

/** Questions about the quote calculator's result panel. */
public final class TheQuote {

  private TheQuote() {}

  /** True once the result panel shows a "$<amount>" price. */
  public static Question<Boolean> showsAPrice() {
    return actor ->
        QuotePage.PRICE.resolveAllFor(actor).stream()
            .map(WebElementFacade::getText)
            .filter(Objects::nonNull)
            .anyMatch(text -> text.matches("(?s).*\\$\\s?\\d.*"));
  }
}
