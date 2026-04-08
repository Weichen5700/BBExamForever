<Query Kind="Program">
  <NuGetReference>Newtonsoft.Json</NuGetReference>
  <Namespace>Newtonsoft.Json</Namespace>
  <IncludeUncapsulator>false</IncludeUncapsulator>
</Query>

public class Question
{
    public string Class { get; set; }
    public string Sn { get; set; }
    public string Type { get; set; }
    public string question { get; set; }  // 對應到JSON中的 "question"
    public List<Option> Options { get; set; }
}

public class Option
{
    [JsonProperty("option")]  // 指定 JSON 鍵名
    public string OptionText { get; set; }

    [JsonProperty("answer")]  // 指定 JSON 鍵名
    public bool Answer { get; set; }
}

public class Program
{
    public static void Main(string[] args)
    {
        string filePath = @"C:\Users\zx304\Desktop\20241104\123.txt";  // 你的txt檔案路徑
        var questionsByClass = new Dictionary<string, List<Question>>();

        // 逐行讀取並解析JSON
        foreach (var line in File.ReadLines(filePath))
        {
            var question = JsonConvert.DeserializeObject<Question>(line);

            // 按類別分類儲存
            if (!questionsByClass.ContainsKey(question.Class))
            {
                questionsByClass[question.Class] = new List<Question>();
            }
            questionsByClass[question.Class].Add(question);
        }

        // 生成HTML格式
        StringBuilder htmlContent = new StringBuilder();
        htmlContent.Append("<html><body style='font-family: Arial; font-size: 10px; line-height: 1.2;'>");

        foreach (var classGroup in questionsByClass)
        {
            htmlContent.Append($"<h3>{classGroup.Key}</h3>");  // 顯示類別名稱

            foreach (var q in classGroup.Value)
            {
                htmlContent.Append($"<div class='question-block' style='margin-bottom: 10px;'>");
                htmlContent.Append($"<p><strong>題號 {q.Sn}:</strong> {q.question}");

                // 將正確答案顯示在題目後面，用紅色粗體加上●符號標記
                foreach (var option in q.Options)
                {
                    if (option.Answer)
                    {
                        htmlContent.Append($" <span style='color: red; font-weight: bold;'>● {option.OptionText}</span>");
                     
                    }
                }

                htmlContent.Append("</p></div>");
            }
        }

        htmlContent.Append("</body></html>");

        // 儲存HTML檔案
        File.WriteAllText(@"C:\Users\zx304\Desktop\20241104\output.html", htmlContent.ToString());

        Console.WriteLine("HTML Q&A output has been generated successfully.");
    }
}
