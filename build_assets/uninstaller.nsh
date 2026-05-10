; uninstaller.nsh — Custom NSIS uninstaller script for Niro
; Offers to delete user data (API keys, chat history) on uninstall

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you want to delete your Niro user data?$\n$\nThis includes your API keys, chat history, and settings.$\nThis cannot be undone." IDNO skip_delete
    ; Delete user data from %APPDATA%\niro
    RMDir /r "$APPDATA\niro"
  skip_delete:
!macroend
