using ElectronNET.API;
using ElectronNET.API.Entities;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Collections.Generic;

var builder = WebApplication.CreateBuilder(args);

// 1. Enable Electron
builder.WebHost.UseElectron(args);
builder.Services.AddControllers();

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseRouting();

app.MapControllers();
app.MapFallbackToFile("index.html");

// Helper to get the correct path for local storage in a desktop app environment
string GetStoragePath(string fileName)
{
    // When running as an EXE, this ensures files save in the app folder
    return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, fileName);
}

// --- LOCAL NOTES API ---
app.MapGet("/api/localnotes", async () =>
{
    string filePath = GetStoragePath("local_notes.json");

    if (!File.Exists(filePath))
    {
        return Results.Ok(new List<object>());
    }

    string json = await File.ReadAllTextAsync(filePath);
    return Results.Text(json, "application/json");
});

app.MapPost("/api/localnotes", async ([FromBody] JsonElement notesData) =>
{
    string filePath = GetStoragePath("local_notes.json");
    string json = JsonSerializer.Serialize(notesData, new JsonSerializerOptions { WriteIndented = true });
    await File.WriteAllTextAsync(filePath, json);
    return Results.Ok(new { message = "Notes saved successfully" });
});

// --- LOCAL SHOUTOUTS API ---
app.MapGet("/api/shoutouts", async () =>
{
    string filePath = GetStoragePath("local_shoutouts.json");

    if (!File.Exists(filePath))
    {
        return Results.Ok(new List<object>());
    }

    string json = await File.ReadAllTextAsync(filePath);
    return Results.Text(json, "application/json");
});

app.MapPost("/api/shoutouts", async ([FromBody] JsonElement shoutoutData) =>
{
    string filePath = GetStoragePath("local_shoutouts.json");
    string json = JsonSerializer.Serialize(shoutoutData, new JsonSerializerOptions { WriteIndented = true });

    await File.WriteAllTextAsync(filePath, json);
    return Results.Ok(new { message = "Shoutouts saved successfully" });
});

// --- ELECTRON WINDOW MANAGEMENT ---
if (HybridSupport.IsElectronActive)
{
    _ = Task.Run(async () =>
    {
        // Small delay to ensure the ASP.NET server is fully ready
        await Task.Delay(2000);

        var options = new BrowserWindowOptions
        {
            Width = 1280,
            Height = 800,
            Title = "Twitch Helper Dashboard",
            WebPreferences = new WebPreferences
            {
                NodeIntegration = true,
                ContextIsolation = false,
                DevTools = true
            }
        };

        var window = await Electron.WindowManager.CreateWindowAsync(options);

        window.OnReadyToShow += () => window.Show();

        // Ensure the app closes completely when the window is closed
        window.OnClosed += () =>
        {
            Electron.App.Quit();
            Environment.Exit(0);
        };
    });
}

app.Run();