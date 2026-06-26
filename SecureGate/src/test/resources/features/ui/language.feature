@ui
Feature: Language switch through the web UI
  The header toggle switches the site between English and Spanish.

  Scenario: The header toggle switches the locale to Spanish
    Given Lena is on the Shipping Hub landing page
    When she switches the language to Spanish
    Then the page URL is on the Spanish locale
