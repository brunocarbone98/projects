package com.securegate.bdd;

import com.securegate.support.SutPreflight;
import io.cucumber.java.BeforeAll;

/**
 * Fails the BDD run fast with one clear, actionable message when the Shipping Hub is down, instead
 * of letting the first API-backed step throw a raw "Connection refused". Cucumber has no notion of
 * an aborted/skipped run the way JUnit's {@code Assumptions} do, so this throws rather than skips.
 * See {@link com.securegate.support.SutPreflight}.
 */
public final class Hooks {

  private Hooks() {}

  @BeforeAll
  public static void requireShippingHub() {
    if (!SutPreflight.isApiUp()) {
      throw new IllegalStateException(SutPreflight.apiDownMessage());
    }
  }
}
