const API = "https://nv7dhfzk5vhoouq57qxdlxekbm0jlupg.lambda-url.us-east-1.on.aws/";

const status = document.getElementById("status");
const fileInput = document.getElementById("fileInput");
const fileList = document.getElementById("fileList");

async function request(url, options = {}) {
  const result = await fetch(url, options);
  if (!result.ok) throw new Error("Request failed: " + result.status);
  return result.json();
}

async function refreshFiles() {
  fileList.replaceChildren();

  try {
    const data = await request(API + "?action=list");

    if (!data.files.length) {
      fileList.textContent = "No files uploaded yet.";
      return;
    }

    for (const file of data.files) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      const download = document.createElement("button");

      name.textContent = `${file.key} (${file.size} bytes)`;
      download.textContent = "Download";

      download.addEventListener("click", async () => {
        try {
          const result = await request(
            API + "?action=download&key=" +
            encodeURIComponent(file.key)
          );
          const a = document.createElement("a");
          a.href = result.url;
          a.download = file.key;
          a.click();
          a.remove();
        } catch (error) {
          status.textContent = "Download failed: " + error.message;
        }
      });

      li.append(name, download);
      fileList.appendChild(li);
    }
  } catch (error) {
    status.textContent = "Could not list files: " + error.message;
  }
}

document.getElementById("uploadButton").addEventListener("click", async () => {
  const file = fileInput.files[0];
  if (!file) {
    status.textContent = "Choose a file first.";
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    status.textContent = "For this demo, files must be under 5 MB.";
    return;
  }

  status.textContent = "Preparing upload...";

  try {
    const result = await request(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || "application/octet-stream"
      })
    });

    console.log("Lambda returned:", result);
    console.log("Presigned URL:", result.url);

    console.log("Lambda response:", result);

    const uploaded = await fetch(result.url, {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/octet-stream"
      },
      body: file
    });

    if (!uploaded.ok) {
        const errorText = await uploaded.text();
        console.error("S3 upload error:", uploaded.status, errorText);
        throw new Error(
                `S3 upload failed (${uploaded.status}): ${errorText}`
        );
    }

    status.textContent = "Upload successful!";
    fileInput.value = "";
    await refreshFiles();
  } catch (error) {
    status.textContent = "Upload failed: " + error.message;
  }
});

document.getElementById("refreshButton")
  .addEventListener("click", refreshFiles);

refreshFiles();