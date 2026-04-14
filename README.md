# Twitch Helper Dashboard 🎮

A desktop dashboard application built with **.NET Core**, **React (Vite)**, and **Electron**. This tool helps Twitch streamers and mods manage raids, track shoutout cooldowns, and sync streamer data with Azure Cloud storage.

## Features (Work in Progress)

- **Raid Tracking:** Automatically detects incoming raids and calculates "Active Viewer" percentages.
- **Shoutout Management:** Smart list that tracks /shoutout cooldowns (60 mins) and prioritizes channels that haven't been thanked yet.
- **Azure Cloud Sync:** Synchronizes streamer history and notes using Azure Blob Storage and SAS URLs.
- **Local Persistence:** Saves session data and personal notes to local JSON files for persistence across restarts.
- **Twitch Integration:** Uses TMI.js for chat interaction and EventSub via WebSockets for real-time shoutout detection.


## Technology Stack

- **Backend:** .NET Core (Minimal API)
- **Frontend:** React.js with Vite
- **Desktop Wrapper:** Electron.NET
- **APIs:** Twitch Helix API, TMI.js, Twitch EventSub (WebSockets)


## Project Structure

- `/SalTwitchApp`: The .NET Core project and Electron entry point.
- `/ui`: The React (Vite) frontend source code.
- `/SalTwitchApp/wwwroot`: The production build of the frontend.


## Setup & Installation

### Prerequisites
- [.NET SDK](https://dotnet.microsoft.com/download)
- [Node.js & npm](https://nodejs.org/)
- [Electron.NET CLI](https://github.com/ElectronNET/Electron.NET)

### Building the Project
1. **Clone the repository**
2. **Build the Frontend:**
   ```bash
   cd ui
   npm install
   npm run build
   cd ../SalTwitchApp
   dotnet tool run electronize start