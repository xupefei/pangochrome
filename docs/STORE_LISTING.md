# Chrome Web Store listing

Text and answers for the Chrome Web Store Developer Dashboard. Upload
`pangochrome-extension-v<version>.zip` from the GitHub release with the same
version.

## Store listing tab

**Summary** comes from the manifest `description`: "Reach Pangolin private
sites through the Pangochrome helper."

**Category:** Developer Tools.

**Language:** English (UK).

**Description:**

```text
Pangochrome lets Chrome reach your Pangolin private resources without a system VPN and without root. It works with Pangolin Cloud and with self-hosted Pangolin.

Only this Chrome profile uses the tunnel. Other apps and other profiles keep the normal network.

Pangochrome needs its helper, a small program that runs the Pangolin client on your computer. After you install the extension, the popup shows one command that downloads, checks and installs the helper. It needs no root.

Features:
- Log in to Pangolin Cloud or to your own Pangolin server, and approve the device in your browser.
- Reach your Pangolin DNS aliases and site subnets from Chrome.
- Choose the organisation.
- Turn on an exit node to send all browser traffic through one of your sites. WebRTC is limited to the proxy while an exit node is on.
- If the tunnel is down, Pangochrome blocks your Pangolin traffic instead of sending it out directly.

Tested on macOS. The Linux helper is not tested on a real desktop yet. Windows is not supported.

Pangochrome is open source (AGPL-3.0): https://github.com/xupefei/pangochrome
Pangochrome is not made by the Pangolin team.
```

**Graphic assets** (from `store-assets/`):

- Store icon: the 128×128 icon in the zip.
- Screenshot (1280×800): `screenshot-connected.png`.
- Small promo tile (440×280): `promo-small.png`.

**Additional fields:**

- Homepage URL: https://github.com/xupefei/pangochrome
- Support URL: https://github.com/xupefei/pangochrome/issues

## Privacy tab

**Single purpose:**

```text
Send this Chrome profile's traffic for the user's Pangolin resources, and with an exit node all its traffic, through the user's Pangolin tunnel, which the Pangochrome helper runs on the same computer.
```

**Permission justifications:**

- `nativeMessaging`: "Talks to the Pangochrome helper on the same computer. The helper runs the Pangolin client and the local proxy."
- `proxy`: "Sets a PAC script that sends the user's Pangolin hosts, or all traffic when an exit node is on, to the helper's proxy on 127.0.0.1. All other traffic goes direct."
- `privacy`: "While an exit node is on, sets webRTCIPHandlingPolicy to disable_non_proxied_udp, so WebRTC cannot send traffic around the exit node."
- `webRequest`, `webRequestAuthProvider`: "Answers the helper proxy's authentication challenge with credentials that exist only for this helper process. It answers only challenges from 127.0.0.1 on the helper's port."
- `storage`: "Keeps a random profile ID, whether the user turned the connection on, and the Pangolin routes of the last connection, so traffic stays blocked while the tunnel is down."
- Host permission `<all_urls>`: "The proxy authentication challenge can come for any request that goes through the helper, so onAuthRequired must see all URLs. The extension does not read or change page content."

**Remote code:** "No, I am not using remote code."

**Data usage.** Check these answers against `docs/PRIVACY.md` before you
submit:

- Personally identifiable information: yes. The popup shows the email address
  and name from the user's Pangolin server. The helper keeps them on the
  computer.
- Authentication information: yes. The helper keeps the Pangolin session
  token and device credentials on the computer and sends them only to the
  user's Pangolin server.
- All other types: no.
- Tick the three statements: no sale or transfer to third parties, no use
  unrelated to the single purpose, no use for credit or lending.

**Privacy policy URL:** https://github.com/xupefei/pangochrome/blob/main/docs/PRIVACY.md

## Distribution tab

- Visibility: Public, or Unlisted for a first test.
- Regions: all.

## Note for reviewers

If the dashboard asks for test instructions:

```text
Pangochrome needs its helper and a Pangolin account. Open the popup, run the install command it shows (macOS or Linux), press Retry, then log in to Pangolin Cloud (free sign-up at https://app.pangolin.net) or to a self-hosted Pangolin server.
```
