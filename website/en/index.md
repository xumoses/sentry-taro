---
layout: home

hero:
  name: Sentry for Taro
  text: Sentry for mini programs
  tagline: A community SDK for Taro React WeChat mini programs, with error monitoring, performance monitoring and opt-in Session Replay.
  actions:
    - theme: brand
      text: Getting started
      link: /en/guide/getting-started
    - theme: alt
      text: Core concepts
      link: /en/guide/concepts
    - theme: alt
      text: GitHub
      link: https://github.com/xumoses/sentry-taro

features:
  - title: Error monitoring
    details: Capture exceptions and unhandled promise rejections with page, network and device context.
    link: /en/guide/api
    linkText: API and configuration
  - title: Performance monitoring
    details: Sample traces for page loads, network requests and custom operations.
    link: /en/guide/api#performance-monitoring
    linkText: Configure sampling
  - title: Session Replay
    details: Opt-in recording of Taro pages through session or error sampling. Text and inputs are masked and media is blocked by default.
    link: /en/guide/replay
    linkText: Set up Replay
  - title: Official semantics
    details: Built on the official @sentry/core 10.76.2. Public APIs and defaults keep Sentry's names and behavior.
    link: /en/guide/concepts
    linkText: Design principles
  - title: Build plugin
    details: Prepare Replay styles and images and release identity at Taro build time, and upload the final WeChat sourcemaps.
    link: /en/guide/taro-plugin
    linkText: Configure the plugin
  - title: AI-assisted setup
    details: An agent skill lets Claude Code, Cursor and similar tools handle setup, Replay configuration and legacy migration.
    link: /en/guide/getting-started#ai-assisted-setup
    linkText: Install the skill
---
