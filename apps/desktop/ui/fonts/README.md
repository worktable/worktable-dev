# Desktop shell fonts

Development loads General Sans directly from the [Fontshare API](https://www.fontshare.com/fonts/general-sans). The font file is not included in public source. Initial loading requires internet access; the existing system-font fallback is used when it is unavailable. The development server replaces only `general-sans.css`; the other fonts remain local.

Packaged Desktop builds use local fonts for offline startup. Before building from public source, obtain the unmodified General Sans variable WOFF2 directly from Fontshare under its [ITF Free Font License](https://www.fontshare.com/licenses/itf-ffl) and place it here as `general-sans-variable.woff2`. Keep that file out of public Git and source archives. Packaging checks that the required WOFF2 files are present. Obtaining the font does not grant unrestricted redistribution rights; follow its own terms when distributing builds.

- `fraunces-variable-latin.woff2` is the Latin subset of Fraunces from Google Fonts. Its [SIL Open Font License 1.1](Fraunces-OFL.txt) and copyright notice are included here.
- `jetbrains-mono-variable-latin.woff2` is the Latin subset of JetBrains Mono from Google Fonts. Its [SIL Open Font License 1.1](JetBrainsMono-OFL.txt) and copyright notice are included here.

Font files retain their own licenses and are not relicensed by the application.
