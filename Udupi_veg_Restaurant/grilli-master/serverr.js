const express = require("express");
const fetch = require("node-fetch");
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/book-table", async (req, res) => {
  const { name, phone, time } = req.body;

  const response = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: {
     authorization: "PASTE_YOUR_REAL_FAST2SMS_API_KEY",
     numbers: "9632693006"   // your phone number, no +91

    },
    body: JSON.stringify({
      route: "q",
      message: `New Table Booking\nName: ${name}\nTime: ${time}`,
      language: "english",
      numbers: "YOUR_PHONE_NUMBER"
    })
  });

  res.json({ success: true });
});

app.listen(3001, () => console.log("Server running on port 3001"));
