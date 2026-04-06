<?php
define('ACCESS', true);

require_once(__DIR__ . "/config/config.php");
require_once(__DIR__ . "/config/cashfree.php");

session_start();
header('Content-Type: application/json');

if (!isset($_SESSION['user_id'])) {
  echo json_encode(["error" => "unauthorized"]);
  exit;
}

$userId = (int) $_SESSION['user_id'];

/* INPUT */
$data = json_decode(file_get_contents("php://input"), true);
$amount = floatval($data['amount'] ?? 0);

if ($amount < 10) {
  echo json_encode(["error" => "min_amount_10"]);
  exit;
}

/* GET PHONE */
$stmt = $conn->prepare("SELECT phone FROM users WHERE id = ?");
$stmt->bind_param("i", $userId);
$stmt->execute();
$stmt->bind_result($phone);
$stmt->fetch();
$stmt->close();

if (!$phone || strlen($phone) < 10) {
  echo json_encode(["error" => "invalid_phone"]);
  exit;
}

/* ORDER ID */
$orderId = "ORD_" . time() . "_" . $userId;

/* PAYLOAD */
$payload = [
  "order_id" => $orderId,
  "order_amount" => $amount,
  "order_currency" => "INR",

  "customer_details" => [
    "customer_id" => "user_" . $userId,
    "customer_phone" => $phone,
    "customer_email" => "user{$userId}@elitepros.com"
  ],

  "order_meta" => [
    "return_url" => "https://testingwithme.infinityfree.me/wallet.php?order_id={order_id}",
    "notify_url" => CF_WEBHOOK_URL
  ]
];

/* CURL */
$ch = curl_init();
curl_setopt_array($ch, [
  CURLOPT_URL => CF_API_BASE,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_POSTFIELDS => json_encode($payload),
  CURLOPT_HTTPHEADER => [
    "Content-Type: application/json",
    "x-api-version: 2025-01-01",
    "x-client-id: " . CF_CLIENT_ID,
    "x-client-secret: " . CF_CLIENT_SECRET
  ]
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$data = json_decode($response, true);

if ($httpCode !== 200 || !isset($data['payment_session_id'])) {
  echo json_encode(["error" => "cashfree_error", "details" => $data]);
  exit;
}

/* SAVE TRANSACTION */
$save = $conn->prepare("
  INSERT INTO transactions (id, user_id, amount, type, status, timestamp)
  VALUES (?, ?, ?, 'deposit', 'pending', UNIX_TIMESTAMP())
");
$save->bind_param("sii", $orderId, $userId, $amount);
$save->execute();

/* RESPONSE */
echo json_encode([
  "payment_session_id" => $data['payment_session_id']
]);