@ui
Feature: Sign in through the web UI
  Customers sign in to reach their dashboard.

  Scenario: Signing in with valid credentials reaches the dashboard
    Given Sandra is on the sign-in page
    When she signs in with the demo customer credentials
    Then she reaches the dashboard

  Scenario: A wrong password shows an inline error
    Given Sandra is on the sign-in page
    When she signs in with a wrong password
    Then she sees an inline error
